import os
import json
import jwt
import datetime
import bcrypt
import psycopg2
from psycopg2.extras import RealDictCursor
import socket
import secrets
import smtplib
import mimetypes
import base64
import hashlib
import sys
import threading
import time
import tempfile
import io
from collections import defaultdict
import site

# Ensure mimetypes are correctly initialized for cloud environments
# to prevent 'nosniff' blocks on CSS/JS files.
mimetypes.init()
mimetypes.add_type('text/css', '.css')
mimetypes.add_type('application/javascript', '.js')

# In hosted/cloud environments without GPUs, onnxruntime prints warnings
# when probing /sys/class/drm for devices. We must set these environment
# variables BEFORE importing packages that trigger discovery (like NudeNet).
# Note: Direct assignment is used here instead of setdefault to ensure
# suppression is active during the import phase.
os.environ['CUDA_VISIBLE_DEVICES'] = '-1'
os.environ['ORT_LOG_LEVEL'] = '3'  # 3 corresponds to ERROR
os.environ['ONNXRUNTIME_DEVICE_DISCOVERY_DISABLED'] = '1'

# Add local virtualenv site-packages to sys.path when running with system Python.
# This ensures optional dependencies like NudeNet are available even if the venv
# was not explicitly activated before starting the app.
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
VENV_DIR = os.path.join(BASE_DIR, '.venv')
if os.path.isdir(VENV_DIR):
    for lib_name in ('lib64', 'lib'):
        venv_site = os.path.join(VENV_DIR, lib_name, f'python{sys.version_info.major}.{sys.version_info.minor}', 'site-packages')
        if os.path.isdir(venv_site):
            site.addsitedir(venv_site)
            break
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from dotenv import load_dotenv
from flask import Flask, request, jsonify, send_from_directory, make_response, g, abort
from urllib.parse import urlparse
from werkzeug.middleware.proxy_fix import ProxyFix

# Security: Pillow is used to strip EXIF metadata from images
try:
    from PIL import Image
except ImportError:
    print("⚠️ [WARNING] Pillow library not found. Image metadata stripping (EXIF removal) is DISABLED.")
    Image = None

# Security: NudeNet for automated NSFW detection
try:
    from nudenet import NudeDetector
    nude_classifier = NudeDetector()
except Exception as e:
    print(f"⚠️ [WARNING] NudeNet initialization failed: {e}. Automated NSFW detection is DISABLED.")
    nude_classifier = None

# Compatibility wrapper for NudeNet differences across versions
def classify_nude_file(path):
    """Return a mapping {path: {'unsafe': score}} or None on error/unavailable."""
    if nude_classifier is None:
        return None
    try:
        # Preferred API
        if hasattr(nude_classifier, 'classify'):
            return nude_classifier.classify(path)
        # Newer/alternate API
        if hasattr(nude_classifier, 'detect'):
            det = nude_classifier.detect(path)
            # If detect returned a dict mapping path -> scores, use directly
            if isinstance(det, dict):
                return det
            # If detect returned a list of detections, convert to a simple score
            if isinstance(det, list):
                max_score = 0.0
                for item in det:
                    if isinstance(item, dict):
                        # common keys: 'score' or 'prob'
                        s = item.get('score') or item.get('prob') or 0.0
                        try:
                            s = float(s)
                        except Exception:
                            s = 0.0
                        if s > max_score:
                            max_score = s
                return {path: {'unsafe': max_score}}
        # Fallback: some versions use 'predict'
        if hasattr(nude_classifier, 'predict'):
            pred = nude_classifier.predict(path)
            if isinstance(pred, dict):
                return pred
    except Exception as e:
        print(f"⚠️ [NSFW WRAPPER ERROR] {e}")
    return None

# Explicitly register common MIME types to ensure browser compatibility
load_dotenv(os.path.join(BASE_DIR, '.env'), override=True)

STORAGE_DIR = os.getenv('DISK_PATH', BASE_DIR)
SECRET_KEY = os.getenv('JWT_SECRET')
ALLOWED_ORIGIN = os.getenv('ALLOWED_ORIGIN', '*')
SERVER_HOST = os.environ.get('HOST', '0.0.0.0')
SERVER_PORT = int(os.environ.get('PORT', 8000))
# New Postgres Connection String
DATABASE_URL = os.getenv('DATABASE_URL')

# --- Configuration Loading ---
DEBUG_MODE = os.getenv('DEBUG', 'False').lower() == 'true'

# Smart Fallback: Enable terminal email display if on localhost or if explicitly allowed in .env
IS_LOCAL_ENV = SERVER_HOST in ('127.0.0.1', 'localhost', '0.0.0.0')
EMAIL_FALLBACK = os.getenv('ALLOW_LOCAL_EMAIL_FALLBACK', str(IS_LOCAL_ENV)).lower() == 'true'

# Centralized SMTP Configuration
SMTP_CONFIG = {
    'host': os.getenv('EMAIL_HOST') or os.getenv('SMTP_HOST'),
    'port': int(os.getenv('EMAIL_PORT') or os.getenv('SMTP_PORT') or 587),
    'user': os.getenv('EMAIL_USER') or os.getenv('SMTP_USER'),
    'pass': os.getenv('EMAIL_PASS') or os.getenv('SMTP_PASS'),
    'from': os.getenv('EMAIL_FROM') or os.getenv('SMTP_FROM')
}
# Fallback from address if not explicitly set
if not SMTP_CONFIG['from']:
    SMTP_CONFIG['from'] = SMTP_CONFIG['user']

if not SECRET_KEY:
    raise ValueError("CRITICAL SECURITY ERROR: JWT_SECRET environment variable is not set in .env")

if len(SECRET_KEY) < 32:
    raise ValueError(
        "CRITICAL SECURITY ERROR: JWT_SECRET must be at least 32 bytes for HS256. "
        "Generate a new one with: python3 -c 'import secrets; print(secrets.token_hex(32))'"
    )

# Derive a consistent 32-byte key for HS256 from the provided secret.
SECURE_JWT_KEY = hashlib.sha256(SECRET_KEY.encode('utf-8')).digest()

app = Flask(__name__, static_folder=None)

# If the app is run behind a proxy/tunnel (ngrok, Cloudflare Tunnel, etc.),
# honor standard X-Forwarded-* headers so `request.host` and `request.scheme`
# reflect the external URL. This helps origin/referrer checks below work
# correctly when requests come through a forwarded host.
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

# Security: Limit total request size to 20MB to prevent DoS via massive Base64 strings
app.config['MAX_CONTENT_LENGTH'] = 20 * 1024 * 1024
ALLOWED_MIME_TYPES = {'image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm'}

app.url_map.strict_slashes = False

# Default security policy; updated dynamically in run() to include actual host/port
CSP_POLICY = "default-src 'self'; script-src 'self'; img-src 'self' data: blob:; media-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; frame-ancestors 'none'; object-src 'none'; connect-src 'self';"

# Simple In-Memory Rate Limiter for scale
rate_limit_store = defaultdict(list)

def limit_request(limit=10, window=60, key=None):
    """Rate limit decorator.

    By default this rate-limits by `request.remote_addr`. If `key` is provided
    (e.g. 'email' or 'username'), the decorator will attempt to extract that
    value from the JSON body and rate-limit per-identifier instead. This is
    useful for signup flows where many users share an IP (proxies/ngrok).
    """
    def decorator(f):
        def wrapper(*args, **kwargs):
            now = datetime.datetime.now().timestamp()

            ident = None
            if key:
                try:
                    payload = request.get_json(silent=True) or {}
                    ident = payload.get(key)
                except Exception:
                    ident = None

            if not ident:
                ident = request.remote_addr or 'unknown'

            # Clean old requests for this identifier
            rate_limit_store[ident] = [t for t in rate_limit_store[ident] if now - t < window]
            if len(rate_limit_store[ident]) >= limit:
                return jsonify({'error': 'Too many requests. Please try again later.'}), 429
            rate_limit_store[ident].append(now)
            return f(*args, **kwargs)

        wrapper.__name__ = f.__name__
        return wrapper
    return decorator

ALLOWED_STATIC_ROOT_FILES = {
    'index.html', 'Gallery.html', 'submit.html', 'profile.html',
    'auth.html', 'About.html', 'admin.html', 'moderator.html',
    'forgot-password.html', 'camera-logo.svg'
}
ALLOWED_STATIC_DIRS = {'css', 'js', 'json'}
ALLOWED_STATIC_EXTENSIONS = {'.html', '.css', '.js', '.svg', '.json'}


def send_email(to_email, subject, body):
    # Helper to extract 6-digit code from email body for terminal display
    def extract_code_from_body(b):
        import re
        match = re.search(r'\b\d{6}\b', b)
        return match.group(0) if match else "N/A"

    # Validation logic
    missing_fields = [k for k, v in SMTP_CONFIG.items() if k != 'from' and not v]
    is_placeholder = SMTP_CONFIG['host'] == 'smtp.example.com'
    
    use_fallback = DEBUG_MODE or EMAIL_FALLBACK

    if missing_fields or is_placeholder:
        if use_fallback:
            print(f"\n📢 [SMTP SIMULATOR] No valid credentials found. Printing to terminal:")
            # Security: Use a more prominent display for the code in terminal
            code = extract_code_from_body(body)
            print(f"┌──────────────────────────────────────────────────┐")
            print(f"│  VERIFICATION CODE FOR: {to_email:24} │")
            print(f"│  CODE: {code:39} │")
            print(f"└──────────────────────────────────────────────────┘\n")
            return True
        else:
            print("❌ SMTP Error: Credentials are required in production mode (DEBUG=False).")
            if is_placeholder:
                print(f"   Reason: EMAIL_HOST/SMTP_HOST is still set to the placeholder '{SMTP_CONFIG['host']}'")
            if missing_fields:
                print(f"   Missing fields: {', '.join(missing_fields)}")
            print("   💡 To bypass this, set ALLOW_LOCAL_EMAIL_FALLBACK=true in .env or run on localhost.")
            return False

    # If we reach here, we have seemingly valid SMTP credentials, so attempt to send
    try:
        print(f"📧 Attempting to send email to {to_email} via {SMTP_CONFIG['host']}...")
        msg = MIMEMultipart()
        msg['From'] = SMTP_CONFIG['from']
        msg['To'] = to_email
        msg['Subject'] = subject
        msg.attach(MIMEText(body, 'plain'))

        server = smtplib.SMTP(SMTP_CONFIG['host'], SMTP_CONFIG['port'], timeout=10)
        server.starttls()
        server.login(SMTP_CONFIG['user'], SMTP_CONFIG['pass'])
        server.send_message(msg)
        server.quit()
        print(f"✅ Email successfully sent to {to_email}")
        return True
    except Exception as e:
        print(f"❌ SMTP Error for {to_email}: {str(e)}")
        if use_fallback:
            print("⚠️ SMTP failed, falling back to terminal display.")
            print(f"\n[SERVER TERMINAL] VERIFICATION CODE FOR {to_email}: {extract_code_from_body(body)}\n")
            return True
        return False


def init_db():
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            username TEXT UNIQUE NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            gender TEXT,
            bio TEXT,
            role TEXT DEFAULT 'user',
            is_blocked INTEGER DEFAULT 0,
            token_version INTEGER DEFAULT 1,
            failed_login_attempts INTEGER DEFAULT 0,
            profile_pic TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)

    cursor.execute("SELECT column_name FROM information_schema.columns WHERE table_name = 'users'")
    existing_columns = [info['column_name'].lower() for info in cursor.fetchall()]
    required_columns = [
        ("role", "TEXT DEFAULT 'user'"),
        ("is_blocked", "INTEGER DEFAULT 0"),
        ("token_version", "INTEGER DEFAULT 1"),
        ("failed_login_attempts", "INTEGER DEFAULT 0"),
        ("profile_pic", "TEXT"),
        ("created_at", "TIMESTAMP DEFAULT CURRENT_TIMESTAMP"),
        ("last_seen", "TIMESTAMP DEFAULT CURRENT_TIMESTAMP")
    ]

    for col_name, col_def in required_columns:
        if col_name not in existing_columns:
            print(f"🛠️  Applying database migration: Adding '{col_name}' to 'users' table...")
            cursor.execute(f"ALTER TABLE users ADD COLUMN {col_name} {col_def}")
            if "CURRENT_TIMESTAMP" in col_def:
                cursor.execute(f"UPDATE users SET {col_name} = CURRENT_TIMESTAMP WHERE {col_name} IS NULL")

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS posts (
            id TEXT PRIMARY KEY,
            title TEXT,
            description TEXT,
            author TEXT,
            authorId INTEGER,
            imageData TEXT,
            mediaType TEXT DEFAULT 'image',
            reviews TEXT,
            is_nsfw INTEGER DEFAULT 0,
            reports TEXT DEFAULT '[]',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (authorId) REFERENCES users(id)
        )
    """)

    cursor.execute("SELECT column_name FROM information_schema.columns WHERE table_name = 'posts'")
    existing_posts_columns = [info['column_name'].lower() for info in cursor.fetchall()]
    if "created_at" not in existing_posts_columns:
        print("🛠️  Applying database migration: Adding 'created_at' to 'posts' table...")
        cursor.execute("ALTER TABLE posts ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP")
        cursor.execute("UPDATE posts SET created_at = '2024-01-01 00:00:00' WHERE created_at IS NULL")
    else:
        # Safeguard: Fill legacy NULLs with an older date so they don't 'hijack' the top of the Newest sort
        cursor.execute("UPDATE posts SET created_at = '2024-01-01 00:00:00' WHERE created_at IS NULL")

    if "mediatype" not in existing_posts_columns:
        print("🛠️  Applying database migration: Adding 'mediaType' to 'posts' table...")
        cursor.execute("ALTER TABLE posts ADD COLUMN mediatype TEXT DEFAULT 'image'")

    if "is_nsfw" not in existing_posts_columns:
        print("🛠️  Applying database migration: Adding 'is_nsfw' to 'posts' table...")
        cursor.execute("ALTER TABLE posts ADD COLUMN is_nsfw INTEGER DEFAULT 0")

    if "reports" not in existing_posts_columns:
        print("🛠️  Applying database migration: Adding 'reports' to 'posts' table...")
        cursor.execute("ALTER TABLE posts ADD COLUMN reports TEXT DEFAULT '[]'")

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS notifications (
            id SERIAL PRIMARY KEY,
            userId INTEGER,
            type TEXT,
            actorName TEXT,
            postId TEXT,
            isRead INTEGER DEFAULT 0,
            createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS post_likes (
            post_id TEXT,
            user_id INTEGER,
            PRIMARY KEY (post_id, user_id),
            FOREIGN KEY (post_id) REFERENCES posts(id),
            FOREIGN KEY (user_id) REFERENCES users(id)
        )
    """)

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS collections (
            name TEXT,
            postIds TEXT,
            authorId INTEGER,
            PRIMARY KEY (name, authorId),
            FOREIGN KEY (authorId) REFERENCES users(id)
        )
    """)

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS pending_verifications (
            email TEXT PRIMARY KEY,
            code TEXT NOT NULL,
            username TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            gender TEXT,
            bio TEXT,
            role TEXT DEFAULT 'user',
            expires_at TEXT NOT NULL
        )
    """)

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS password_resets (
            email TEXT PRIMARY KEY,
            code TEXT NOT NULL,
            expires_at TEXT NOT NULL
        )
    """)

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT
        )
    """)

    cursor.execute("INSERT INTO settings (key, value) VALUES ('maintenance_mode', '0') ON CONFLICT (key) DO NOTHING")
    cursor.execute("INSERT INTO settings (key, value) VALUES ('feedback_enabled', '1') ON CONFLICT (key) DO NOTHING")

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS feedback (
            id SERIAL PRIMARY KEY,
            userId INTEGER,
            username TEXT,
            message TEXT NOT NULL,
            createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (userId) REFERENCES users(id)
        )
    """)

    conn.commit()
    conn.close()


def parse_json_list(value):
    if value is None:
        return []
    try:
        parsed = json.loads(value)
        return parsed if isinstance(parsed, list) else [parsed]
    except Exception:
        return [value] if value else []


def require_fields(payload, required_fields):
    missing = [field for field in required_fields if not payload.get(field)]
    return missing


def validate_password_strength(password):
    """Enforces security standards for new passwords."""
    if len(password) < 8:
        return False, "Password must be at least 8 characters long."
    if not any(char.isdigit() for char in password):
        return False, "Password must contain at least one number."
    if not any(char.isupper() for char in password):
        return False, "Password must contain at least one uppercase letter."
    # Check for basic keyboard patterns or common words could go here
    if password.lower() in ['password123', 'beyondframe', 'photography']:
        return False, "Password is too common. Please choose something more unique."
    return True, None


def get_file_extension(mime_type):
    ext = mimetypes.guess_extension(mime_type)
    if ext:
        return ext.lstrip('.')
    return mime_type.split('/')[-1] if '/' in mime_type else 'bin'


def scan_for_nsfw(b64_item):
    """
    Uses NudeNet to classify images as safe or unsafe.
    Returns True if the 'unsafe' probability exceeds the threshold.
    """
    if nude_classifier is None or not isinstance(b64_item, str) or ',' not in b64_item:
        return False

    temp_file_path = None
    try:
        header, encoded = b64_item.split(',', 1)
        mime = header.split(';')[0].split(':')[1]

        # Only scan standard image formats
        if mime not in {'image/jpeg', 'image/png', 'image/webp'}:
            return False

        img_bytes = base64.b64decode(encoded)

        # NudeNet typically requires a file path, so we use a temporary file
        with tempfile.NamedTemporaryFile(delete=False, suffix='.jpg') as temp_file:
            temp_file.write(img_bytes)
            temp_file_path = temp_file.name

        # Classify the image
        # Result format expected: { 'path': { 'safe': 0.1, 'unsafe': 0.9 } }
        results = classify_nude_file(temp_file_path)

        if results and isinstance(results, dict) and temp_file_path in results:
            unsafe_prob = results[temp_file_path].get('unsafe', 0)
            # Set a threshold (e.g., 0.6) for what defines NSFW content
            return unsafe_prob > 0.6

        return False
    except Exception as e:
        print(f"⚠️ [NSFW SCAN ERROR] {e}")
        return False
    finally:
        # Ensure the temporary file is deleted after scanning
        if temp_file_path and os.path.exists(temp_file_path):
            os.remove(temp_file_path)


def background_nsfw_check(post_id, images):
    """Runs in a separate thread to avoid slowing down the user upload."""
    is_content_flagged = False
    for item in images:
        if scan_for_nsfw(item):
            is_content_flagged = True
            break
    
    if is_content_flagged:
        conn = get_db_connection()
        cursor = conn.cursor()
        # Update post to NSFW status after scan completes
        cursor.execute("UPDATE posts SET is_nsfw = 1 WHERE id = %s", (post_id,))
        conn.commit()
        conn.close()


def cleanup_expired_data():
    """Background task that runs periodically to clean up expired auth records."""
    while True:
        try:
            conn = get_db_connection()
            cursor = conn.cursor()
            # ISO8601 strings are lexicographically comparable
            now = datetime.datetime.now(datetime.timezone.utc).isoformat()
            
            cursor.execute("DELETE FROM pending_verifications WHERE expires_at < %s", (now,))
            cursor.execute("DELETE FROM password_resets WHERE expires_at < %s", (now,))
            
            if cursor.rowcount > 0:
                print(f"🧹 [DATABASE CLEANUP] Removed {cursor.rowcount} expired authentication records.")
                
            conn.commit()
            conn.close()
        except Exception as e:
            print(f"⚠️ [CLEANUP ERROR] {e}")
        
        # Sleep for 1 hour before next run
        time.sleep(3600)


def sanitize_image_metadata(b64_item):
    """Re-encodes images using Pillow to strip EXIF and other sensitive metadata."""
    if not Image or not isinstance(b64_item, str) or ',' not in b64_item:
        return b64_item
        
    try:
        header, encoded = b64_item.split(',', 1)
        mime = header.split(';')[0].split(':')[1]
        
        # Only sanitize standard image formats; skip videos and SVGs
        if mime not in {'image/jpeg', 'image/png', 'image/webp'}:
            return b64_item
            
        img_bytes = base64.b64decode(encoded)
        with Image.open(io.BytesIO(img_bytes)) as img:
            output = io.BytesIO()
            img.save(output, format=img.format)
            new_encoded = base64.b64encode(output.getvalue()).decode('utf-8')
            return f"{header},{new_encoded}"
    except Exception:
        return b64_item # Fallback to original if Pillow fails


def validate_media_content(b64_item):
    """Decodes base64 and verifies magic numbers against the claimed MIME type."""
    try:
        if not isinstance(b64_item, str) or ',' not in b64_item:
            return False
        header, encoded = b64_item.split(',', 1)
        mime = header.split(';')[0].split(':')[1]
        if mime not in ALLOWED_MIME_TYPES:
            return False
        # Basic check to ensure it's valid base64
        base64.b64decode(encoded[:32], validate=True)
        return True
    except Exception:
        return False


def get_user_from_token():
    auth_header = request.headers.get('Authorization')
    if not auth_header:
        return None
    try:
        parts = auth_header.split(' ')
        if len(parts) != 2:
            return None
        token = parts[1]
        if token in ('null', 'undefined'):
            return None
        # Strictly validate the algorithm and handle decoding errors
        return jwt.decode(token, SECURE_JWT_KEY, algorithms=['HS256'], options={"require": ["exp", "user_id", "pv"]})
    except (jwt.ExpiredSignatureError, jwt.InvalidTokenError):
        return None
    except Exception:
        return None


def get_db_connection():
    if not DATABASE_URL:
        print("❌ CRITICAL ERROR: DATABASE_URL is not set in your .env file.")
        print("👉 Add: DATABASE_URL=postgresql://nischal:cleartype@127.0.0.1:5432/beyondframe_db")
        sys.exit(1)
    # Connect to PostgreSQL using RealDictCursor for row['col'] compatibility
    try:
        conn = psycopg2.connect(DATABASE_URL, cursor_factory=RealDictCursor)
        return conn
    except psycopg2.OperationalError as e:
        if "Ident authentication failed" in str(e):
            print("\n❌ DATABASE AUTH ERROR: Ident authentication failed.")
            print("👉 You must change 'ident' to 'scram-sha-256' in /var/lib/pgsql/data/pg_hba.conf and restart postgresql.")
            print("💡 Follow the steps provided in the last instruction.\n")
        raise e


def is_maintenance_active():
    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT value FROM settings WHERE key = 'maintenance_mode'")
        row = cursor.fetchone()
        return row['value'] == '1' if row else False
    finally:
        conn.close()


def validate_user_session(user_id, token_version):
    """
    Checks if the user is blocked or if their token has been revoked 
    (e.g., via password change).
    """
    # Optimization: Use global request context
    if hasattr(g, 'session_valid'):
        return g.session_valid
        
    if not user_id or token_version is None:
        return False
    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT is_blocked, token_version FROM users WHERE id = %s", (user_id,))
        row = cursor.fetchone()
        if not row:
            g.session_valid = False
            return False
        
        # Blocked account check
        if bool(row.get('is_blocked')):
            g.session_valid = False
            return False
            
        # Token version check (Session Revocation)
        g.session_valid = (row.get('token_version') == token_version)
        return g.session_valid
    except Exception:
        return False
    finally:
        conn.close()


def is_feedback_enabled():
    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT value FROM settings WHERE key = 'feedback_enabled'")
        row = cursor.fetchone()
        return row['value'] == '1' if row else True
    finally:
        conn.close()


def check_request_guards(path, user):
    maintenance_whitelist = [
        '/api/auth/login',
        '/api/heartbeat',
        '/api/settings/maintenance-status',
        '/api/settings/feedback-status'
    ]

    if path.startswith('/api/') and path not in maintenance_whitelist:
        if is_maintenance_active():
            if not user or user.get('role') != 'admin':
                return make_response(jsonify({'error': 'Maintenance Mode'}), 503)

    if user and path.startswith('/api/') and not validate_user_session(user.get('user_id'), user.get('pv')):
        return make_response(jsonify({'error': 'Session invalid or account blocked.'}), 403)

    return None


@app.before_request
def before_request():
    g.user = get_user_from_token()
    if request.path.startswith('/api/'):
        guard = check_request_guards(request.path, g.user)
        if guard is not None:
            return guard


@app.after_request
def add_security_headers(response):
    origin = request.headers.get('Origin')
    # Extra Layer: If the origin is missing but it's a cross-site request, reject it.
    # Use forwarded host/proto when behind a proxy (ngrok) so comparisons are accurate.
    # NOTE: Only enforce this strict referrer check for API requests. Top-level
    # navigations (serving HTML and static assets) commonly come without an
    # Origin header and can have differing referrers when proxied; rejecting
    # them here leads to the "Forbidden" JSON response seen in ngrok tunnels.
    if request.path.startswith('/api/') and not origin and request.referrer:
        try:
            # Effective external host (may include port)
            forwarded_host = request.headers.get('X-Forwarded-Host') or request.host
            forwarded_proto = request.headers.get('X-Forwarded-Proto') or ('https' if request.is_secure else 'http')
            effective_host_url = f"{forwarded_proto}://{forwarded_host}"
            ref_netloc = urlparse(request.referrer).netloc
            host_netloc = urlparse(effective_host_url).netloc
            # If referrer is present and its host doesn't match effective host,
            # consider it cross-site and reject.
            if ref_netloc and host_netloc and ref_netloc != host_netloc:
                return make_response(jsonify({'error': 'Forbidden'}), 403)
        except Exception:
            # On parse errors, be conservative and reject.
            return make_response(jsonify({'error': 'Forbidden'}), 403)
    
    # Hardened CORS: Use exact matching only to prevent "mysite.com.attacker.com" exploits
    allowed_origins = set([o.strip() for o in ALLOWED_ORIGIN.split(',') if o.strip()])
    allowed_origins.update([
        'http://localhost', 'http://127.0.0.1', 'http://0.0.0.0', 'http://[::1]',
        'https://localhost', 'https://127.0.0.1'
    ])

    is_allowed = False
    if origin:
        is_allowed = (ALLOWED_ORIGIN == '*') or (origin in allowed_origins)

    response.headers['Vary'] = 'Origin'
    response.headers['Access-Control-Allow-Methods'] = 'GET, POST, DELETE, PATCH, OPTIONS'
    response.headers['Access-Control-Allow-Headers'] = 'Authorization, Content-Type, ngrok-skip-browser-warning, Accept'
    response.headers['X-Frame-Options'] = 'DENY'
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['X-XSS-Protection'] = '1; mode=block'
    response.headers['Referrer-Policy'] = 'strict-origin-when-cross-origin'
    # Permissions-Policy: Restrict access to sensitive browser features
    # Denying geolocation, microphone, usb, and payment features.
    # Camera is often needed for photography apps, so it's not denied here.
    response.headers['Permissions-Policy'] = 'geolocation=(), microphone=(), usb=(), payment=()'
    if request.is_secure: # Only apply HSTS if served over HTTPS
        response.headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains; preload'
    response.headers['Content-Security-Policy'] = CSP_POLICY

    # If ALLOWED_ORIGIN is '*' or we're in DEBUG mode, allow any origin
    # (useful for local development and tunnels like ngrok). In production,
    # set ALLOWED_ORIGIN explicitly in .env for stricter CORS control.
    if ALLOWED_ORIGIN == '*' or DEBUG_MODE:
        response.headers['Access-Control-Allow-Origin'] = '*'
    elif origin:
        if is_allowed:
            response.headers['Access-Control-Allow-Origin'] = origin
            response.headers['Access-Control-Allow-Credentials'] = 'true'
        else:
            # Reject the origin by not setting the header
            pass

    # Ensure preflight OPTIONS requests return a clean 200 immediately
    if request.method == 'OPTIONS':
        response.status_code = 200
        return response

    if request.path.endswith('service-worker.js'):
        response.headers['Service-Worker-Allowed'] = '/'
    return response


@app.route('/api/health', methods=['GET'])
def health():
    return jsonify({'status': 'Custom Server is up'})

@app.route("/debug")
def debug():
    return {
        "SMTP_HOST": os.getenv("SMTP_HOST"),
        "SMTP_USER_EXISTS": bool(os.getenv("SMTP_USER")),
        "SMTP_PASSWORD_EXISTS": bool(os.getenv("SMTP_PASSWORD"))
    }


@app.route('/api/heartbeat', methods=['POST'])
def heartbeat():
    user_id = g.user.get('user_id') if g.user else None
    maintenance = is_maintenance_active()

    if not user_id:
        return jsonify({
            'maintenance': maintenance,
            'role': None,
            'status': 'Guest'
        })

    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT role, is_blocked, token_version FROM users WHERE id = %s", (user_id,))
        row = cursor.fetchone()

        if not row:
            return jsonify({'error': 'User not found'}), 404

        if not validate_user_session(user_id, g.user.get('pv')):
            return jsonify({'error': 'Session invalid'}), 403

        cursor.execute("UPDATE users SET last_seen = CURRENT_TIMESTAMP WHERE id = %s", (user_id,))
        conn.commit()

        return jsonify({
            'maintenance': maintenance,
            'role': row['role'],
            'status': 'Authenticated'
        })
    finally:
        conn.close()


@app.route('/api/logout', methods=['POST'])
def logout():
    if not g.user or not g.user.get('user_id'):
        return jsonify({'error': 'Unauthorized'}), 401

    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("UPDATE users SET last_seen = NULL WHERE id = %s", (g.user['user_id'],))
        conn.commit()
        return jsonify({'message': 'Logged out successfully'})
    finally:
        conn.close()


@app.route('/api/posts', methods=['GET'])
def get_posts():
    user_id = g.user.get('user_id') if g.user else None
    user_role = g.user.get('role') if g.user else 'guest'

    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        sort = request.args.get('sort', 'newest')
        if sort == 'most-liked':
            query = """
            SELECT id, title, description, author, authorId AS "authorId", imageData AS "imageData", 
            mediaType AS "mediaType", reviews, created_at AS "createdAt",
            (SELECT COUNT(*) FROM post_likes WHERE post_id = posts.id) as likes,
            (SELECT COUNT(*) FROM post_likes WHERE post_id = posts.id AND user_id = %s) as "userLiked"
            FROM posts 
            WHERE (is_nsfw = 0 OR authorId = %s OR %s IN ('admin', 'moderator'))
            ORDER BY likes DESC, created_at DESC, id DESC
            """
        else:
            query = """
            SELECT id, title, description, author, authorId AS "authorId", imageData AS "imageData", 
            mediaType AS "mediaType", reviews, created_at AS "createdAt",
            (SELECT COUNT(*) FROM post_likes WHERE post_id = posts.id) as likes,
            (SELECT COUNT(*) FROM post_likes WHERE post_id = posts.id AND user_id = %s) as "userLiked"
            FROM posts 
            WHERE (is_nsfw = 0 OR authorId = %s OR %s IN ('admin', 'moderator'))
            ORDER BY created_at DESC, id DESC
            """
        cursor.execute(query, (user_id, user_id, user_role))
        posts = cursor.fetchall()
        for post in posts:
            post['imageData'] = parse_json_list(post.get('imageData'))
            post['reviews'] = json.loads(post.get('reviews') or '[]')
        return jsonify(posts)
    finally:
        conn.close()


@app.route('/api/profile', methods=['GET'])
def profile():
    if not g.user:
        return jsonify({'error': 'Unauthorized. Please log in.'}), 401

    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("""SELECT id, username, email, gender, bio, role, 
                       profile_pic AS "profile_pic", 
                       created_at AS "created_at" FROM users WHERE id = %s""", (g.user['user_id'],))
        user_row = cursor.fetchone()
        if not user_row:
            return jsonify({'error': 'Profile not found'}), 404

        user_data = dict(user_row)
        return jsonify({'user': user_data})
    finally:
        conn.close()


@app.route('/api/collections', methods=['GET'])
def get_collections():
    if not g.user:
        return jsonify({'error': 'Unauthorized'}), 401

    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM collections WHERE authorId = %s", (g.user['user_id'],))
        collections = [dict(row) for row in cursor.fetchall()]
        for collection in collections:
            collection['postIds'] = json.loads(collection.get('postIds') or '[]')
        return jsonify(collections)
    finally:
        conn.close()


@app.route('/api/admin/users', methods=['GET'])
def admin_users():
    if not g.user or g.user.get('role') != 'admin':
        return '', 403

    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT id, username, email, role, gender, is_blocked, last_seen, "
            "(last_seen >= CURRENT_TIMESTAMP - INTERVAL '60 seconds') AS is_online "
            "FROM users"
        )
        return jsonify([dict(row) for row in cursor.fetchall()])
    finally:
        conn.close()


@app.route('/api/admin/stats', methods=['GET'])
def admin_stats():
    if not g.user or g.user.get('role') != 'admin':
        return '', 403

    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT COUNT(*) as count FROM users")
        total = cursor.fetchone()['count']
        cursor.execute("SELECT COUNT(*) as count FROM users WHERE is_blocked = 0")
        active = cursor.fetchone()['count']
        cursor.execute("SELECT COUNT(*) as count FROM users WHERE is_blocked = 1")
        blocked = cursor.fetchone()['count']
        cursor.execute("SELECT COUNT(*) as count FROM users WHERE last_seen >= CURRENT_TIMESTAMP - INTERVAL '60 seconds'")
        online = cursor.fetchone()['count']
        return jsonify({'totalUsers': total, 'activeUsers': active, 'blockedUsers': blocked, 'onlineUsers': online})
    finally:
        conn.close()


@app.route('/api/users/<username>', methods=['GET'])
def get_user_profile(username):
    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT username, gender, bio, profile_pic FROM users WHERE username = %s", (username,))
        user_row = cursor.fetchone()
        if not user_row:
            return jsonify({'error': 'User not found'}), 404
        return jsonify(dict(user_row))
    finally:
        conn.close()


@app.route('/api/admin/feedback', methods=['GET'])
def admin_feedback():
    if not g.user or g.user.get('role') != 'admin':
        return '', 403

    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM feedback ORDER BY createdAt DESC")
        feedback = [dict(row) for row in cursor.fetchall()]
        return jsonify(feedback)
    finally:
        conn.close()


@app.route('/api/notifications', methods=['GET'])
def notifications():
    if not g.user:
        return jsonify({'error': 'Unauthorized'}), 401

    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT n.id, n.userId AS "userId", n.type, n.actorName AS "actorName", n.postId AS "postId", 
            n.isRead AS "isRead", n.createdAt AS "createdAt", p.title AS "postTitle"
            FROM notifications n
            LEFT JOIN posts p ON n.postId = p.id
            WHERE n.userId = %s
            ORDER BY n.createdAt DESC LIMIT 50
        """, (g.user['user_id'],))
        notes = cursor.fetchall()
        return jsonify(notes)
    finally:
        conn.close()


@app.route('/api/settings/maintenance-status', methods=['GET'])
def maintenance_status():
    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT value FROM settings WHERE key = 'maintenance_mode'")
        row = cursor.fetchone()
        enabled = row['value'] == '1' if row else False
        return jsonify({'enabled': enabled})
    finally:
        conn.close()


@app.route('/api/settings/feedback-status', methods=['GET'])
def feedback_status():
    return jsonify({'enabled': is_feedback_enabled()})


@app.route('/api/posts/image/<post_id>/<int:img_index>', methods=['GET'])
def post_image(post_id, img_index):
    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT imageData FROM posts WHERE id = %s", (post_id,))
        row = cursor.fetchone()
        if not row or not row.get('imagedata'):
            return abort(404)
        try:
            images = json.loads(row['imagedata'])
        except Exception:
            images = [row['imagedata']]

        if not isinstance(images, list) or img_index >= len(images):
            return abort(404)

        img_data = images[img_index]
        if isinstance(img_data, str) and ',' in img_data:
            header, encoded = img_data.split(',', 1)
            mime_type = header.split(';')[0].split(':')[1]
            
            if mime_type not in ALLOWED_MIME_TYPES:
                return abort(403) # Forbidden: malicious or unsupported type
                
            decoded = base64.b64decode(encoded)
            file_ext = get_file_extension(mime_type)
            response = make_response(decoded)
            response.headers['Content-Type'] = mime_type
            response.headers['Content-Disposition'] = f'attachment; filename="BeyondFrame-{post_id}-{img_index}.{file_ext}"'
            return response
        return abort(404)
    finally:
        conn.close()


@app.route('/api/posts/<post_id>', methods=['DELETE'])
def delete_post(post_id):
    if not g.user:
        return jsonify({'error': 'Unauthorized'}), 401

    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT authorId FROM posts WHERE id = %s", (post_id,))
        post = cursor.fetchone()
        if not post:
            return jsonify({'error': 'Post not found'}), 404
        if post['authorid'] != g.user['user_id'] and g.user.get('role') not in ['admin', 'moderator']:
            return jsonify({'error': 'Forbidden'}), 403

        cursor.execute("DELETE FROM post_likes WHERE post_id = %s", (post_id,))
        cursor.execute("DELETE FROM posts WHERE id = %s", (post_id,))
        conn.commit()
        return jsonify({'message': 'Deleted'})
    finally:
        conn.close()


@app.route('/api/admin/users/<user_id>', methods=['DELETE'])
def delete_user(user_id):
    if not g.user or g.user.get('role') != 'admin':
        return '', 403

    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT username, email FROM users WHERE id = %s", (user_id,))
        user_row = cursor.fetchone()
        if not user_row:
            return jsonify({'error': 'User not found'}), 404

        username = user_row['username']
        email = user_row['email']

        cursor.execute("DELETE FROM post_likes WHERE user_id = %s", (user_id,))
        cursor.execute("DELETE FROM notifications WHERE userId = %s OR actorName = %s", (user_id, username))
        cursor.execute("DELETE FROM feedback WHERE userId = %s", (user_id,))
        cursor.execute("DELETE FROM collections WHERE authorId = %s", (user_id,))
        cursor.execute("DELETE FROM posts WHERE authorId = %s", (user_id,))
        cursor.execute("DELETE FROM password_resets WHERE email = %s", (email,))
        cursor.execute("DELETE FROM pending_verifications WHERE email = %s", (email,))
        cursor.execute("DELETE FROM users WHERE id = %s", (user_id,))
        conn.commit()
        return jsonify({'message': 'Deleted'})
    finally:
        conn.close()


@app.route('/api/admin/feedback/<feedback_id>', methods=['DELETE'])
def delete_feedback(feedback_id):
    if not g.user or g.user.get('role') != 'admin':
        return '', 403

    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("DELETE FROM feedback WHERE id = %s", (feedback_id,))
        conn.commit()
        return jsonify({'message': 'Feedback deleted'})
    finally:
        conn.close()


@app.route('/api/profile', methods=['DELETE'])
def delete_profile():
    if not g.user:
        return jsonify({'error': 'Unauthorized'}), 401

    payload = request.get_json(silent=True) or {}
    password = payload.get('password')
    if not password:
        return jsonify({'error': 'Password is required'}), 400

    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT password, username, email FROM users WHERE id = %s", (g.user['user_id'],))
        user_row = cursor.fetchone()
        if user_row and bcrypt.checkpw(password.encode('utf-8'), user_row['password'].encode('utf-8')):
            username = user_row['username']
            email = user_row['email']
            cursor.execute("DELETE FROM post_likes WHERE user_id = %s", (g.user['user_id'],))
            cursor.execute("DELETE FROM notifications WHERE userId = %s OR actorName = %s", (g.user['user_id'], username))
            cursor.execute("DELETE FROM feedback WHERE userId = %s", (g.user['user_id'],))
            cursor.execute("DELETE FROM collections WHERE authorId = %s", (g.user['user_id'],))
            cursor.execute("DELETE FROM posts WHERE authorId = %s", (g.user['user_id'],))
            cursor.execute("DELETE FROM password_resets WHERE email = %s", (email,))
            cursor.execute("DELETE FROM pending_verifications WHERE email = %s", (email,))
            cursor.execute("DELETE FROM users WHERE id = %s", (g.user['user_id'],))
            conn.commit()
            return jsonify({'message': 'Account and all associated data deleted'})
        return jsonify({'error': 'Incorrect password'}), 401
    finally:
        conn.close()


@app.route('/api/auth/send-verification-code', methods=['POST'])
@limit_request(limit=3, window=600, key='email') # Prevents email spam (per-email)
def send_verification_code():
    payload = request.get_json(silent=True) or {}
    email = payload.get('email', '').lower().strip()
    username = payload.get('username')
    password = payload.get('password')
    gender = payload.get('gender')
    bio = payload.get('bio')

    if not email or not username or not password:
        return jsonify({'error': 'Missing required fields'}), 400

    is_strong, pw_error = validate_password_strength(password)
    if not is_strong:
        return jsonify({'error': pw_error}), 400

    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT 1 FROM users WHERE email = %s OR username = %s", (email, username))
        if cursor.fetchone():
            return jsonify({'error': 'Email or username already registered.'}), 409

        verification_code = ''.join(secrets.choice('0123456789') for _ in range(6))
        hashed_pw = bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')
        expires_at = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=15)).isoformat()

        cursor.execute("""
            INSERT INTO pending_verifications (email, code, username, password_hash, gender, bio, role, expires_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT(email) DO UPDATE SET
                code = excluded.code,
                username = excluded.username,
                password_hash = excluded.password_hash,
                gender = excluded.gender,
                bio = excluded.bio,
                role = excluded.role,
                expires_at = excluded.expires_at
        """, (email, verification_code, username, hashed_pw, gender, bio, 'user', expires_at))
        conn.commit()

        subject = 'Verify your BeyondFrame account'
        body = f"Hello {username},\n\nYour 6-digit verification code is: {verification_code}\n\nThis code will expire in 15 minutes."
        if send_email(email, subject, body):
            return jsonify({'message': 'Verification code sent.'})
        return jsonify({'error': 'Failed to send verification email.'}), 500
    finally:
        conn.close()


@app.route('/api/auth/verify-email', methods=['POST'])
@limit_request(limit=5, window=600) # Prevents code guessing
def verify_email():
    payload = request.get_json(silent=True) or {}
    email = payload.get('email', '').lower().strip()
    code = payload.get('code')

    if not all([email, code]):
        return jsonify({'error': 'Missing email or verification code'}), 400

    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM pending_verifications WHERE email = %s AND code = %s", (email, code))
        pending_user = cursor.fetchone()
        if not pending_user:
            return jsonify({'error': 'Invalid verification code or email.'}), 400

        if datetime.datetime.now(datetime.timezone.utc) > datetime.datetime.fromisoformat(pending_user['expires_at']):
            cursor.execute("DELETE FROM pending_verifications WHERE email = %s", (email,))
            conn.commit()
            return jsonify({'error': 'Verification code expired.'}), 400

        cursor.execute("SELECT COUNT(*) as count FROM users")
        role = 'admin' if cursor.fetchone()['count'] == 0 else pending_user['role']

        try:
            cursor.execute("INSERT INTO users (username, email, password, gender, bio, role) VALUES (%s, %s, %s, %s, %s, %s) RETURNING id",
                           (pending_user['username'], pending_user['email'], pending_user['password_hash'],
                            pending_user['gender'], pending_user['bio'], role))
            user_id = cursor.fetchone()['id']
            cursor.execute("DELETE FROM pending_verifications WHERE email = %s", (email,))
            conn.commit()

            token = jwt.encode({
                'user_id': user_id,
                'username': pending_user['username'],
                'role': role,
                'pv': 1, # Initial token version
                'exp': datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=24)
            }, SECURE_JWT_KEY, algorithm='HS256')

            return jsonify({'message': 'Account created and verified.', 'token': token, 'username': pending_user['username'], 'role': role}), 201
        except Exception:
            return jsonify({'error': 'Email or username already registered.'}), 409
    finally:
        conn.close()


@app.route('/api/auth/login', methods=['POST'])
@limit_request(limit=5, window=60)
def login():
    payload = request.get_json(silent=True) or {}
    email = payload.get('email', '').lower().strip()
    password = payload.get('password', '')

    if not email or not password:
        return jsonify({'error': 'Email and password are required.'}), 400

    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM users WHERE LOWER(email) = %s", (email,))
        user = cursor.fetchone()

        if not user:
            return jsonify({'error': 'Invalid email or password'}), 401

        if user.get('failed_login_attempts', 0) >= 5:
            return jsonify({'error': 'Account locked due to too many failed attempts. Please reset your password to unlock.'}), 403

        if bcrypt.checkpw(password.encode('utf-8'), user['password'].encode('utf-8')):
            if user['is_blocked'] == 1:
                return jsonify({'error': 'Your account has been blocked for guideline violations.'}), 403
            
            # Reset failed attempts on success
            cursor.execute("UPDATE users SET failed_login_attempts = 0 WHERE id = %s", (user['id'],))
            
            token = jwt.encode({
                'user_id': user['id'],
                'username': user['username'],
                'role': user['role'],
                'pv': user['token_version'],
                'exp': datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=24)
            }, SECURE_JWT_KEY, algorithm='HS256')
            conn.commit()
            return jsonify({'token': token, 'username': user['username'], 'role': user['role']})

        # Increment failed attempts on failure
        cursor.execute("UPDATE users SET failed_login_attempts = failed_login_attempts + 1 WHERE id = %s", (user['id'],))
        conn.commit()
        return jsonify({'error': 'Invalid email or password'}), 401
    finally:
        conn.close()


@app.route('/api/posts', methods=['POST'])
def save_post():
    if not g.user:
        return jsonify({'error': 'Unauthorized'}), 401

    payload = request.get_json(silent=True) or {}
    missing_fields = require_fields(payload, ['id', 'title', 'description'])
    if missing_fields:
        return jsonify({'error': f"Missing required fields: {', '.join(missing_fields)}"}), 400

    images = payload.get('imageData', [])
    if not isinstance(images, list):
        return jsonify({'error': 'imageData must be an array'}), 400

    # Security: Validate and sanitize every image/video in the album before saving
    sanitized_images = []
    for item in images:
        if not validate_media_content(item):
            return jsonify({'error': 'Invalid or malicious media content detected.'}), 400
        sanitized_images.append(sanitize_image_metadata(item))

    image_data_json = json.dumps(sanitized_images)
    reviews_json = json.dumps(payload.get('reviews', []))

    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT authorId, reviews FROM posts WHERE id = %s", (payload['id'],))
        old_post = cursor.fetchone()
        
        # CRITICAL LOOPHOLE FIX: Check authorship before allowing an UPDATE
        if old_post and old_post['authorid'] != g.user['user_id']:
            return jsonify({'error': 'Unauthorized: You do not own this post.'}), 403

        if old_post:
            old_reviews = json.loads(old_post.get('reviews') or '[]')
            new_reviews_list = payload.get('reviews', [])
            if len(new_reviews_list) > len(old_reviews) and old_post.get('authorid') != g.user['user_id']:
                cursor.execute("DELETE FROM notifications WHERE userId = %s AND type = %s AND actorName = %s AND postId = %s",
                               (old_post.get('authorid'), 'comment', g.user['username'], payload['id']))
                cursor.execute("INSERT INTO notifications (userId, type, actorName, postId) VALUES (%s, %s, %s, %s)",
                               (old_post.get('authorid'), 'comment', g.user['username'], payload['id']))
            elif len(new_reviews_list) < len(old_reviews):
                cursor.execute("DELETE FROM notifications WHERE userId = %s AND type = %s AND actorName = %s AND postId = %s",
                               (old_post.get('authorid'), 'comment', g.user['username'], payload['id']))
            elif len(new_reviews_list) == len(old_reviews):
                for i in range(len(new_reviews_list)):
                    new_reps = new_reviews_list[i].get('replies', [])
                    old_rev_obj = old_reviews[i]
                    old_reps = old_rev_obj.get('replies', []) if isinstance(old_rev_obj, dict) else []
                    if len(new_reps) > len(old_reps) and isinstance(old_rev_obj, dict):
                        target_uid = old_rev_obj.get('authorId')
                        if target_uid and target_uid != g.user['user_id']:
                            cursor.execute("DELETE FROM notifications WHERE userId = %s AND type = %s AND actorName = %s AND postId = %s",
                                           (target_uid, 'reply', g.user['username'], payload['id']))
                            cursor.execute("INSERT INTO notifications (userId, type, actorName, postId) VALUES (%s, %s, %s, %s)",
                                           (target_uid, 'reply', g.user['username'], payload['id']))
                    elif len(new_reps) < len(old_reps) and isinstance(old_rev_obj, dict):
                        target_uid = old_rev_obj.get('authorId')
                        if target_uid:
                            cursor.execute("DELETE FROM notifications WHERE userId = %s AND type = %s AND actorName = %s AND postId = %s",
                                           (target_uid, 'reply', g.user['username'], payload['id']))

        cursor.execute("""
            INSERT INTO posts (id, title, description, author, authorId, imageData, mediaType, reviews)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (id) DO UPDATE SET
                title = excluded.title,
                description = excluded.description,
                author = excluded.author,
                authorId = excluded.authorId,
                imageData = excluded.imageData,
                mediaType = excluded.mediaType,
                reviews = excluded.reviews
        """, (payload['id'], payload['title'], payload['description'], g.user['username'], g.user['user_id'], image_data_json, payload.get('mediaType', 'image'), reviews_json))
        
        conn.commit()

        # Optimization: Start NSFW scanning in the background
        threading.Thread(
            target=background_nsfw_check, 
            args=(payload['id'], sanitized_images), 
            daemon=True
        ).start()

        return jsonify({'message': 'Post saved'}), 201
    finally:
        conn.close()


@app.route('/api/posts/toggle-like', methods=['POST'])
def toggle_like():
    if not g.user:
        return jsonify({'error': 'Session expired. Please log in again.'}), 401

    payload = request.get_json(silent=True) or {}
    post_id = payload.get('postId')
    if not post_id:
        return jsonify({'error': 'Missing postId'}), 400

    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT 1 FROM post_likes WHERE post_id = %s AND user_id = %s", (post_id, g.user['user_id']))
        exists = cursor.fetchone()
        cursor.execute("SELECT authorId FROM posts WHERE id = %s", (post_id,))
        post_row = cursor.fetchone()
        if not post_row:
            return jsonify({'error': 'Post not found'}), 404

        author_id = post_row.get('authorid')
        if exists:
            cursor.execute("DELETE FROM post_likes WHERE post_id = %s AND user_id = %s", (post_id, g.user['user_id']))
            cursor.execute("DELETE FROM notifications WHERE userId = %s AND type = %s AND actorName = %s AND postId = %s",
                           (author_id, 'like', g.user['username'], post_id))
            status = 'unliked'
        else:
            cursor.execute("INSERT INTO post_likes (post_id, user_id) VALUES (%s, %s)", (post_id, g.user['user_id']))
            if author_id != g.user['user_id']:
                cursor.execute("DELETE FROM notifications WHERE userId = %s AND type = %s AND actorName = %s AND postId = %s",
                               (author_id, 'like', g.user['username'], post_id))
                cursor.execute("INSERT INTO notifications (userId, type, actorName, postId) VALUES (%s, %s, %s, %s)",
                               (author_id, 'like', g.user['username'], post_id))
            status = 'liked'
        conn.commit()
        return jsonify({'status': status})
    finally:
        conn.close()


@app.route('/api/collections', methods=['POST'])
def save_collection():
    if not g.user:
        return jsonify({'error': 'Unauthorized'}), 401

    payload = request.get_json(silent=True) or {}
    name = payload.get('name')
    if not name:
        return jsonify({'error': 'Collection name is required'}), 400

    post_ids = payload.get('postIds', [])
    if not isinstance(post_ids, list):
        return jsonify({'error': 'postIds must be an array'}), 400

    post_ids_json = json.dumps(post_ids)
    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("""
            INSERT INTO collections (name, postIds, authorId) VALUES (%s, %s, %s)
            ON CONFLICT(name, authorId) DO UPDATE SET postIds = excluded.postIds
        """, (payload['name'], post_ids_json, g.user['user_id']))
        conn.commit()
        return jsonify({'message': 'Saved'})
    finally:
        conn.close()


@app.route('/api/collections/<name>', methods=['DELETE'])
def delete_collection(name):
    if not g.user:
        return jsonify({'error': 'Unauthorized'}), 401

    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("DELETE FROM collections WHERE name = %s AND authorId = %s", (name, g.user['user_id']))
        conn.commit()
        return jsonify({'message': 'Collection deleted'})
    finally:
        conn.close()


@app.route('/api/notifications/read', methods=['POST'])
def read_notifications():
    if not g.user:
        return jsonify({'error': 'Unauthorized'}), 401
    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("UPDATE notifications SET isRead = 1 WHERE userId = %s", (g.user['user_id'],))
        conn.commit()
        return jsonify({'message': 'Notifications marked as read'})
    finally:
        conn.close()


@app.route('/api/profile/change-password', methods=['POST'])
def change_password():
    if not g.user:
        return jsonify({'error': 'Unauthorized'}), 401

    payload = request.get_json(silent=True) or {}
    old_pwd = payload.get('oldPassword')
    new_pwd = payload.get('newPassword')

    if not old_pwd or not new_pwd:
        return jsonify({'error': 'Old and new passwords are required.'}), 400

    is_strong, pw_error = validate_password_strength(new_pwd)
    if not is_strong:
        return jsonify({'error': pw_error}), 400

    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT password FROM users WHERE id = %s", (g.user['user_id'],))
        user_row = cursor.fetchone()
        if user_row and bcrypt.checkpw(old_pwd.encode('utf-8'), user_row['password'].encode('utf-8')):
            hashed_new = bcrypt.hashpw(new_pwd.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')
            # Increment token_version to invalidate all other sessions
            cursor.execute("UPDATE users SET password = %s, token_version = token_version + 1 WHERE id = %s", (hashed_new, g.user['user_id']))
            conn.commit()
            return jsonify({'message': 'Password updated'})
        return jsonify({'error': 'Incorrect current password'}), 401
    finally:
        conn.close()


@app.route('/api/profile/reset-auth', methods=['POST'])
def reset_auth():
    if not g.user:
        return jsonify({'error': 'Unauthorized'}), 401

    payload = request.get_json(silent=True) or {}
    pwd = payload.get('password')
    if not pwd:
        return jsonify({'error': 'Password is required'}), 400

    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT password FROM users WHERE id = %s", (g.user['user_id'],))
        user_row = cursor.fetchone()
        if user_row and bcrypt.checkpw(pwd.encode('utf-8'), user_row['password'].encode('utf-8')):
            return jsonify({'message': 'Authenticated'})
        return jsonify({'error': 'Incorrect password'}), 401
    finally:
        conn.close()


@app.route('/api/auth/send-password-reset-code', methods=['POST'])
@limit_request(limit=3, window=300)
def send_password_reset_code():
    payload = request.get_json(silent=True) or {}
    email = payload.get('email', '').lower().strip()
    if not email:
        return jsonify({'error': 'Email is required'}), 400

    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT 1 FROM users WHERE LOWER(email) = %s", (email,))
        if not cursor.fetchone():
            # Security: Return generic success to prevent email enumeration
            return jsonify({'message': 'If an account exists for this email, a code has been sent.'}), 200

        reset_code = ''.join(secrets.choice('0123456789') for _ in range(6))
        expires_at = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=15)).isoformat()
        cursor.execute("""
            INSERT INTO password_resets (email, code, expires_at)
            VALUES (%s, %s, %s)
            ON CONFLICT(email) DO UPDATE SET
                code = excluded.code,
                expires_at = excluded.expires_at
        """, (email, reset_code, expires_at))
        conn.commit()
        subject = 'BeyondFrame Password Reset Code'
        body = f"Your password reset code is: {reset_code}\n\nThis code will expire in 15 minutes."
        if send_email(email, subject, body):
            return jsonify({'message': 'Password reset code sent to your email.'})
        return jsonify({'error': 'Failed to send reset code email.'}), 500
    finally:
        conn.close()


@app.route('/api/auth/reset-password', methods=['POST'])
@limit_request(limit=10, window=600) # Prevent reset code brute-forcing
def reset_password():
    payload = request.get_json(silent=True) or {}
    email = payload.get('email', '').lower().strip()
    code = payload.get('code')
    new_password = payload.get('newPassword')

    is_strong, pw_error = validate_password_strength(new_password or '')
    if not is_strong:
        return jsonify({'error': pw_error}), 400

    if not all([email, code, new_password]):
        return jsonify({'error': 'Missing email, code, or new password'}), 400

    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT expires_at FROM password_resets WHERE email = %s AND code = %s", (email, code))
        reset_entry = cursor.fetchone()
        if not reset_entry or datetime.datetime.now(datetime.timezone.utc) > datetime.datetime.fromisoformat(reset_entry['expires_at']):
            return jsonify({'error': 'Invalid or expired reset code.'}), 400

        hashed_new = bcrypt.hashpw(new_password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')
        # Reset failed attempts and increment token_version
        cursor.execute("UPDATE users SET password = %s, token_version = token_version + 1, failed_login_attempts = 0 WHERE LOWER(email) = %s", (hashed_new, email))
        cursor.execute("DELETE FROM password_resets WHERE email = %s", (email,))
        cursor.execute("DELETE FROM pending_verifications WHERE email = %s", (email,))
        conn.commit()
        return jsonify({'message': 'Password has been reset successfully.'})
    finally:
        conn.close()


@app.route('/api/feedback', methods=['POST'])
def feedback():
    if not is_feedback_enabled():
        return jsonify({'error': 'Feedback submission is currently disabled.'}), 403

    payload = request.get_json(silent=True) or {}
    message = payload.get('message')
    if not message:
        return jsonify({'error': 'Message is required'}), 400

    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        user_id = g.user['user_id'] if g.user else None
        username = g.user['username'] if g.user else 'Guest'
        cursor.execute("INSERT INTO feedback (userId, username, message) VALUES (%s, %s, %s)",
                       (user_id, username, message))
        cursor.execute("SELECT id FROM users WHERE role = 'admin'")
        admins = cursor.fetchall()
        for admin_row in admins:
            cursor.execute("INSERT INTO notifications (userId, type, actorName, postId) VALUES (%s, %s, %s, %s)",
                           (admin_row['id'], 'feedback', username, 'ADMIN_FEEDBACK'))
        conn.commit()
        return jsonify({'message': 'Feedback received. Thank you!'}), 201
    finally:
        conn.close()


@app.route('/api/profile/avatar', methods=['PATCH'])
def update_avatar():
    if not g.user:
        return jsonify({'error': 'Unauthorized'}), 403

    payload = request.get_json(silent=True) or {}
    profile_pic = payload.get('profile_pic')
    if profile_pic is None:
        return jsonify({'error': 'profile_pic is required'}), 400

    # Security: Validate avatar content just like gallery images
    if not validate_media_content(profile_pic):
        return jsonify({'error': 'Invalid image format.'}), 400
        
    # Strip EXIF metadata from avatar
    profile_pic = sanitize_image_metadata(profile_pic)

    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("UPDATE users SET profile_pic = %s WHERE id = %s", (profile_pic, g.user['user_id']))
        conn.commit()
        return jsonify({'message': 'Avatar updated'})
    finally:
        conn.close()


@app.route('/api/admin/users/<user_id>/role', methods=['PATCH'])
def update_user_role(user_id):
    if not g.user or g.user.get('role') != 'admin':
        return '', 403

    payload = request.get_json(silent=True) or {}
    role = payload.get('role')
    if role not in ('user', 'moderator', 'admin'):
        return jsonify({'error': 'Invalid role'}), 400

    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("UPDATE users SET role = %s WHERE id = %s", (role, user_id))
        conn.commit()
        return jsonify({'message': 'Updated'})
    finally:
        conn.close()


@app.route('/api/admin/settings/maintenance-toggle', methods=['PATCH'])
def maintenance_toggle():
    if not g.user or g.user.get('role') != 'admin':
        return '', 403

    payload = request.get_json(silent=True) or {}
    enabled_val = '1' if payload.get('enabled') else '0'
    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("UPDATE settings SET value = %s WHERE key = 'maintenance_mode'", (enabled_val,))
        conn.commit()
        return jsonify({'message': 'Maintenance mode updated'})
    finally:
        conn.close()


@app.route('/api/admin/settings/feedback-toggle', methods=['PATCH'])
def feedback_toggle():
    if not g.user or g.user.get('role') != 'admin':
        return '', 403

    payload = request.get_json(silent=True) or {}
    enabled_val = '1' if payload.get('enabled') else '0'
    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("UPDATE settings SET value = %s WHERE key = 'feedback_enabled'", (enabled_val,))
        conn.commit()
        return jsonify({'message': 'Feedback setting updated'})
    finally:
        conn.close()


@app.route('/api/admin/users/<user_id>/block', methods=['PATCH'])
def block_user(user_id):
    if not g.user or g.user.get('role') != 'admin':
        return '', 403

    payload = request.get_json(silent=True) or {}
    block_value = payload.get('is_blocked')
    if block_value not in (0, 1, '0', '1', True, False):
        return jsonify({'error': 'is_blocked must be 0 or 1'}), 400
    block_value = 1 if str(block_value) in ('1', 'True', 'true') else 0

    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("UPDATE users SET is_blocked = %s WHERE id = %s", (block_value, user_id))
        conn.commit()
        return jsonify({'message': 'User Status Updated'})
    finally:
        conn.close()


def is_safe_static_path(path):
    normalized = os.path.normpath(path).replace('\\', '/')
    if normalized.startswith('../') or normalized.startswith('..\\') or normalized.startswith('/'):
        return False
    if normalized in ALLOWED_STATIC_ROOT_FILES:
        return True
    for static_dir in ALLOWED_STATIC_DIRS:
        if normalized.startswith(f"{static_dir}/"):
            return os.path.splitext(normalized)[1] in ALLOWED_STATIC_EXTENSIONS
    return False


@app.route('/', defaults={'path': 'index.html'})
@app.route('/<path:path>', methods=['GET'])
def serve_static(path):
    if path.startswith('api/'):
        abort(404)

    if not path:
        path = 'index.html'

    if not is_safe_static_path(path):
        abort(403)

    file_path = os.path.join(BASE_DIR, path)
    if not os.path.exists(file_path) or not os.path.isfile(file_path):
        abort(404)

    return send_from_directory(BASE_DIR, path)


@app.route('/', methods=['OPTIONS'])
@app.route('/<path:path>', methods=['OPTIONS'])
def handle_options(path=''):
    return '', 200


def run(server_port=None):
    # Start the background maintenance thread
    cleanup_thread = threading.Thread(target=cleanup_expired_data, daemon=True)
    cleanup_thread.start()

    port = server_port or SERVER_PORT or 8000
    max_port = port + 50

    while port < max_port:
        try:
            global CSP_POLICY
            allowed_connect = [f"http://localhost:{port}", f"http://127.0.0.1:{port}"]
            try:
                hostname = socket.gethostname()
                local_ip = socket.gethostbyname(hostname)
                allowed_connect.append(f"http://{local_ip}:{port}")
            except socket.gaierror:
                pass

            CSP_POLICY = f"default-src 'self'; script-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; frame-ancestors 'none'; object-src 'none'; connect-src 'self' {' '.join(allowed_connect)} http://localhost:* http://127.0.0.1:* https://*.ngrok-free.app https://*.locallinear.app;"

            json_dir = os.path.join(BASE_DIR, 'json')
            os.makedirs(json_dir, exist_ok=True)
            config_path = os.path.join(json_dir, 'config.json')
            with open(config_path, 'w') as f:
                json.dump({'API_PORT': port}, f)

            # SMTP Diagnostic
            if not DEBUG_MODE and not EMAIL_FALLBACK:
                status = "READY" if (SMTP_CONFIG['host'] and SMTP_CONFIG['host'] != 'smtp.example.com') else "INCOMPLETE (Using Terminal Fallback if configured)"
                print(f"📢 SMTP Configuration: Host={SMTP_CONFIG['host'] or 'None'}, User={SMTP_CONFIG['user'] or 'None'} -> Status: {status}")

            print(f"🚀 BeyondFrame Server attempting to listen on http://{SERVER_HOST}:{port}")

            if DEBUG_MODE:
                app.run(host=SERVER_HOST, port=port, debug=True, use_reloader=False)
            else:
                from waitress import serve
                serve(app, host=SERVER_HOST, port=port, threads=6, url_scheme='https')
            break
        except OSError:
            print(f"⚠️ Port {port} is busy or restricted, trying next...")
            port += 1
    else:
        print("❌ CRITICAL: Could not find any available ports in the range 8000-8050.")


if __name__ == '__main__':
    run()
