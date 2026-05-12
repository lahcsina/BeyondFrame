import os
import json
import jwt
import datetime
import bcrypt
import sqlite3
import socket
import secrets
import smtplib
import mimetypes
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse
from socketserver import ThreadingMixIn
from dotenv import load_dotenv

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
# Explicitly load .env from the script's directory
load_dotenv(os.path.join(BASE_DIR, '.env'))

# Use /data path for persistent storage on Render, otherwise use local directory
STORAGE_DIR = os.getenv('DISK_PATH', BASE_DIR)
DB_FILE = os.path.join(STORAGE_DIR, 'users.db')

SECRET_KEY = os.getenv('JWT_SECRET')
ALLOWED_ORIGIN = os.getenv('ALLOWED_ORIGIN', '*')
DEBUG_MODE = os.getenv('DEBUG', 'False').lower() == 'true'

if not SECRET_KEY:
    raise ValueError("CRITICAL SECURITY ERROR: JWT_SECRET environment variable is not set in .env")

def send_email(to_email, subject, body):
    """Helper to send email via SMTP."""
    host = os.getenv('EMAIL_HOST') or os.getenv('SMTP_HOST')
    port = int(os.getenv('EMAIL_PORT') or os.getenv('SMTP_PORT') or 587)
    user = os.getenv('EMAIL_USER') or os.getenv('SMTP_USER')
    password = os.getenv('EMAIL_PASS') or os.getenv('SMTP_PASS')
    from_addr = os.getenv('EMAIL_FROM') or os.getenv('SMTP_FROM') or user

    if not host or not user or not password:
        print("\n[DEBUG] Email variables missing. Host: {}, User: {}, Pass: {}".format(
            "Set" if host else "Missing", 
            "Set" if user else "Missing", 
            "Set" if password else "Missing"
        ))
        print("⚠️ SMTP credentials missing in .env. Falling back to terminal output.")
        print(f"\n[SERVER TERMINAL] VERIFICATION CODE FOR {to_email}: {body.split(': ')[-1].split()[0]}\n")
        return True

    try:
        print(f"📧 Attempting to send email to {to_email} via {host}...")
        msg = MIMEMultipart()
        msg['From'] = from_addr
        msg['To'] = to_email
        msg['Subject'] = subject
        msg.attach(MIMEText(body, 'plain'))

        server = smtplib.SMTP(host, port, timeout=10)
        server.starttls()  # Secure the connection
        server.login(user, password)
        server.send_message(msg)
        server.quit()
        print(f"✅ Email successfully sent to {to_email}")
        return True
    except Exception as e:
        print(f"❌ SMTP Error for {to_email}: {str(e)}")
        return False

def init_db():
    try:
        conn = sqlite3.connect(DB_FILE)
        # Enable Write-Ahead Logging for better concurrency
        conn.execute("PRAGMA journal_mode=WAL")
    except sqlite3.OperationalError as e:
        if "readonly database" in str(e):
            print(f"❌ Permission Error: Cannot write to {DB_FILE}")
            print(f"💡 Try running: sudo chown -R $USER:$USER {BASE_DIR}")
            import sys; sys.exit(1)
        raise e

    cursor = conn.cursor()
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            gender TEXT,
            bio TEXT,
            role TEXT DEFAULT 'user',
            is_blocked INTEGER DEFAULT 0,
            profile_pic TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)

    # Migration: Ensure columns added in later updates exist for legacy databases
    cursor.execute("PRAGMA table_info(users)")
    existing_columns = [info[1] for info in cursor.fetchall()]
    
    required_columns = [
        ("role", "TEXT DEFAULT 'user'"),
        ("is_blocked", "INTEGER DEFAULT 0"),
        ("profile_pic", "TEXT"),
        ("created_at", "TIMESTAMP DEFAULT CURRENT_TIMESTAMP"),
        ("last_seen", "TIMESTAMP DEFAULT CURRENT_TIMESTAMP")
    ]

    for col_name, col_def in required_columns:
        if col_name not in existing_columns:
            print(f"🛠️  Applying database migration: Adding '{col_name}' to 'users' table...")
            if "CURRENT_TIMESTAMP" in col_def:
                # SQLite ALTER TABLE does not support non-constant defaults like CURRENT_TIMESTAMP
                type_only = col_def.split("DEFAULT")[0].strip()
                cursor.execute(f"ALTER TABLE users ADD COLUMN {col_name} {type_only}")
                cursor.execute(f"UPDATE users SET {col_name} = CURRENT_TIMESTAMP")
            else:
                cursor.execute(f"ALTER TABLE users ADD COLUMN {col_name} {col_def}")

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS posts (
            id TEXT PRIMARY KEY,
            title TEXT,
            description TEXT,
            author TEXT,
            authorId INTEGER,
            imageData TEXT,
            reviews TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (authorId) REFERENCES users(id)
        )
    """)

    # Migration for posts table (ensure created_at exists for legacy DBs)
    cursor.execute("PRAGMA table_info(posts)")
    existing_posts_columns = [info[1] for info in cursor.fetchall()]
    if "created_at" not in existing_posts_columns:
        print("🛠️  Applying database migration: Adding 'created_at' to 'posts' table...")
        cursor.execute("ALTER TABLE posts ADD COLUMN created_at TIMESTAMP")
        cursor.execute("UPDATE posts SET created_at = CURRENT_TIMESTAMP")

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS notifications (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            userId INTEGER,
            type TEXT, -- 'like', 'comment', 'reply'
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
        CREATE TABLE IF NOT EXISTS reports (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            postId TEXT,
            reason TEXT,
            reportedBy INTEGER,
            status TEXT DEFAULT 'pending'
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
    # New table for email verification
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
    # New table for password reset tokens
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS password_resets (
            email TEXT PRIMARY KEY,
            code TEXT NOT NULL,
            expires_at TEXT NOT NULL
        )
    """)
    # New table for site-wide feedback and complaints
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS site_feedback (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            userId INTEGER,
            username TEXT,
            content TEXT,
            type TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (userId) REFERENCES users(id)
        )
    """)
    # Settings table for platform-wide toggles
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT
        )
    """)
    # Initialize default state
    cursor.execute("INSERT OR IGNORE INTO settings (key, value) VALUES ('feedback_enabled', '1')")
    cursor.execute("INSERT OR IGNORE INTO settings (key, value) VALUES ('maintenance_mode', '0')")
    conn.commit()
    conn.close()

class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    """Handle requests in a separate thread."""
    pass

class RequestHandler(BaseHTTPRequestHandler):
    def _set_headers(self, status=200, content_type='application/json'):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Access-Control-Allow-Origin', ALLOWED_ORIGIN)
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, DELETE, PATCH, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Authorization, Content-Type')
        # Security Headers
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; frame-ancestors 'none'; object-src 'none'; connect-src 'self';")
        self.end_headers()

    def _serve_file(self, path):
        """Helper to serve static files from the BASE_DIR."""
        if path == '/': path = '/index.html'
        file_path = os.path.join(BASE_DIR, path.lstrip('/'))
        
        # Prevent directory traversal attacks
        if not os.path.abspath(file_path).startswith(BASE_DIR):
            self._set_headers(403)
            return

        if os.path.exists(file_path) and os.path.isfile(file_path):
            self.send_response(200)
            ctype, _ = mimetypes.guess_type(file_path)
            self.send_header('Content-Type', ctype or 'application/octet-stream')
            if path.endswith('service-worker.js'):
                self.send_header('Service-Worker-Allowed', '/')
            self.send_header('X-Frame-Options', 'DENY')
            self.end_headers()
            with open(file_path, 'rb') as f:
                self.wfile.write(f.read())
        else:
            self._set_headers(404)
            self.wfile.write(json.dumps({'error': 'File not found'}).encode())

    def do_OPTIONS(self):
        self._set_headers()

    def get_user_from_token(self):
        auth_header = self.headers.get('Authorization')
        if not auth_header: return None
        try:
            parts = auth_header.split(" ")
            if len(parts) != 2: return None
            token = parts[1]
            if token == "null" or token == "undefined": return None
            return jwt.decode(token, SECRET_KEY, algorithms=["HS256"])
        except: return None

    def is_maintenance_active(self):
        conn = sqlite3.connect(DB_FILE, timeout=10)
        try:
            cursor = conn.cursor()
            cursor.execute("SELECT value FROM settings WHERE key = 'maintenance_mode'")
            row = cursor.fetchone()
            return row[0] == '1' if row else False
        finally:
            conn.close()

    def do_GET(self):
        parsed_path = urlparse(self.path)
        # Normalize path: remove trailing slash but keep root as '/'
        path = parsed_path.path.rstrip('/')
        if not path: path = '/'

        if path == '/api/health':
            self._set_headers()
            self.wfile.write(json.dumps({'status': 'Custom Server is up'}).encode())
        
        elif path == '/api/posts':
            user = self.get_user_from_token()
            user_id = user['user_id'] if user else None
            conn = sqlite3.connect(DB_FILE, timeout=10)
            try:
                conn.row_factory = sqlite3.Row
                cursor = conn.cursor()
                cursor.execute("""
                    SELECT id, title, description, author, authorId, imageData, reviews, created_at,
                    (SELECT COUNT(*) FROM post_likes WHERE post_id = posts.id) as likes,
                    (SELECT COUNT(*) FROM post_likes WHERE post_id = posts.id AND user_id = ?) as userLiked
                    FROM posts ORDER BY created_at DESC
                """, (user_id,))
                posts = [dict(row) for row in cursor.fetchall()]
                for p in posts:
                    try:
                        parsed = json.loads(p['imageData'] or '[]')
                        p['imageData'] = parsed if isinstance(parsed, list) else [parsed]
                    except:
                        p['imageData'] = [p['imageData']] if p['imageData'] else []
                    p['reviews'] = json.loads(p['reviews'] or '[]')
                self._set_headers()
                self.wfile.write(json.dumps(posts).encode())
            finally:
                conn.close()
        
        elif path == '/api/profile':
            user = self.get_user_from_token()
            if not user:
                self._set_headers(401)
                self.wfile.write(json.dumps({'error': 'Unauthorized. Please log in.'}).encode())
                return
            
            conn = sqlite3.connect(DB_FILE, timeout=10)
            try:
                conn.row_factory = sqlite3.Row
                cursor = conn.cursor()
                cursor.execute("SELECT id, username, email, gender, bio, role, profile_pic, created_at FROM users WHERE id = ?", (user['user_id'],))
                user_row = cursor.fetchone()
                if not user_row:
                    self._set_headers(404); return
                
                user_data = dict(user_row)
                cursor.execute("""
                    SELECT id, title, description, author, authorId, imageData, reviews, created_at,
                    (SELECT COUNT(*) FROM post_likes WHERE post_id = posts.id) as likes,
                    (SELECT COUNT(*) FROM post_likes WHERE post_id = posts.id AND user_id = ?) as userLiked
                    FROM posts WHERE authorId = ? ORDER BY created_at DESC
                """, (user['user_id'], user['user_id']))
                posts = [dict(row) for row in cursor.fetchall()]
                for p in posts:
                    try:
                        parsed = json.loads(p['imageData'] or '[]')
                        p['imageData'] = parsed if isinstance(parsed, list) else [parsed]
                    except:
                        p['imageData'] = [p['imageData']] if p['imageData'] else []
                    p['reviews'] = json.loads(p['reviews'] or '[]')
                self._set_headers()
                self.wfile.write(json.dumps({'user': user_data, 'posts': posts}).encode())
            finally:
                conn.close()

        elif path == '/api/collections':
            user = self.get_user_from_token()
            if not user:
                self._set_headers(401)
                return
            conn = sqlite3.connect(DB_FILE, timeout=10)
            try:
                conn.row_factory = sqlite3.Row
                cursor = conn.cursor()
                cursor.execute("SELECT * FROM collections WHERE authorId = ?", (user['user_id'],))
                cols = [dict(row) for row in cursor.fetchall()]
                for col in cols:
                    col['postIds'] = json.loads(col['postIds'])
                self._set_headers()
                self.wfile.write(json.dumps(cols).encode())
            finally:
                conn.close()

        elif path == '/api/admin/users':
            user = self.get_user_from_token()
            if not user or user.get('role') != 'admin':
                self._set_headers(403)
                return
            conn = sqlite3.connect(DB_FILE, timeout=10)
            try:
                conn.row_factory = sqlite3.Row
                cursor = conn.cursor()
                cursor.execute("SELECT id, username, email, role, gender, is_blocked, last_seen FROM users")
                users = [dict(row) for row in cursor.fetchall()]
                self._set_headers()
                self.wfile.write(json.dumps(users).encode())
            finally:
                conn.close()

        elif path == '/api/admin/stats':
            user = self.get_user_from_token()
            if not user or user.get('role') != 'admin':
                self._set_headers(403)
                return
            conn = sqlite3.connect(DB_FILE, timeout=10)
            try:
                cursor = conn.cursor()
                cursor.execute("SELECT COUNT(*) FROM users")
                total = cursor.fetchone()[0]
                cursor.execute("SELECT COUNT(*) FROM users WHERE is_blocked = 0")
                active = cursor.fetchone()[0]
                cursor.execute("SELECT COUNT(*) FROM users WHERE is_blocked = 1")
                blocked = cursor.fetchone()[0]
                # Count users seen within the last 60 seconds for true real-time accuracy
                cursor.execute("SELECT COUNT(*) FROM users WHERE last_seen >= datetime('now', '-60 seconds')")
                online = cursor.fetchone()[0]
                self._set_headers()
                self.wfile.write(json.dumps({'totalUsers': total, 'activeUsers': active, 'blockedUsers': blocked, 'onlineUsers': online}).encode())
            finally:
                conn.close()

        elif path.startswith('/api/users/'):
            username = path.split('/')[-1]
            conn = sqlite3.connect(DB_FILE, timeout=10)
            try:
                conn.row_factory = sqlite3.Row
                cursor = conn.cursor()
                cursor.execute("SELECT username, gender, bio, profile_pic FROM users WHERE username = ?", (username,))
                user_row = cursor.fetchone()
                if not user_row:
                    self._set_headers(404)
                    self.wfile.write(json.dumps({'error': 'User not found'}).encode())
                    return
                user_data = dict(user_row)
                self._set_headers()
                self.wfile.write(json.dumps(user_data).encode())
            finally:
                conn.close()

        elif path == '/api/notifications':
            user = self.get_user_from_token()
            if not user:
                self._set_headers(401); return
            
            conn = sqlite3.connect(DB_FILE, timeout=10)
            try:
                conn.row_factory = sqlite3.Row
                cursor = conn.cursor()
                cursor.execute("""
                    SELECT n.*, p.title as postTitle 
                    FROM notifications n 
                    LEFT JOIN posts p ON n.postId = p.id 
                    WHERE n.userId = ? 
                    ORDER BY n.createdAt DESC LIMIT 50
                """, (user['user_id'],))
                notes = [dict(row) for row in cursor.fetchall()]
                self._set_headers()
                self.wfile.write(json.dumps(notes).encode())
            finally:
                conn.close()

        elif path == '/api/feedback':
            user = self.get_user_from_token()
            if not user or user.get('role') not in ['admin', 'moderator']:
                self._set_headers(403)
                self.wfile.write(json.dumps({'error': 'Forbidden. Only administrators can view site feedback.'}).encode())
                return
            conn = sqlite3.connect(DB_FILE, timeout=10)
            try:
                conn.row_factory = sqlite3.Row
                cursor = conn.cursor()
                cursor.execute("SELECT * FROM site_feedback ORDER BY created_at DESC")
                feedback = [dict(row) for row in cursor.fetchall()]
                self._set_headers()
                self.wfile.write(json.dumps(feedback).encode())
            finally:
                conn.close()

        elif path == '/api/settings/maintenance-status':
            conn = sqlite3.connect(DB_FILE, timeout=10)
            try:
                cursor = conn.cursor()
                cursor.execute("SELECT value FROM settings WHERE key = 'maintenance_mode'")
                row = cursor.fetchone()
                enabled = row[0] == '1' if row else False
                self._set_headers()
                self.wfile.write(json.dumps({'enabled': enabled}).encode())
            finally:
                conn.close()

        elif path == '/api/settings/feedback-status':
            conn = sqlite3.connect(DB_FILE, timeout=10)
            try:
                cursor = conn.cursor()
                cursor.execute("SELECT value FROM settings WHERE key = 'feedback_enabled'")
                row = cursor.fetchone()
                enabled = row[0] == '1' if row else True
                self._set_headers()
                self.wfile.write(json.dumps({'enabled': enabled}).encode())
            finally:
                conn.close()

        elif path.startswith('/api/posts/image/'):
            # Usage: /api/posts/image/<post_id>/<index>
            parts = path.split('/')
            if len(parts) >= 6:
                post_id = parts[4]
                try:
                    img_index = int(parts[5])
                except: img_index = 0
                
                conn = sqlite3.connect(DB_FILE, timeout=10)
                try:
                    cursor = conn.cursor()
                    cursor.execute("SELECT imageData FROM posts WHERE id = ?", (post_id,))
                    row = cursor.fetchone()
                    if row and row[0]:
                        images = json.loads(row[0])
                        if isinstance(images, list) and img_index < len(images):
                            img_data = images[img_index]
                            if img_data.startswith('data:image/'):
                                # Extract header and content
                                header, encoded = img_data.split(",", 1)
                                mime_type = header.split(";")[0].split(":")[1]
                                import base64
                                decoded = base64.b64decode(encoded)
                                self.send_response(200)
                                self.send_header('Content-Type', mime_type)
                                self.send_header('Access-Control-Allow-Origin', ALLOWED_ORIGIN)
                                self.end_headers()
                                self.wfile.write(decoded)
                                return
                finally:
                    conn.close()
            self._set_headers(404)

        else:
            # Serve static files for any non-API GET request
            self._serve_file(path)

    def do_DELETE(self):
        parsed_path = urlparse(self.path)
        path = parsed_path.path.rstrip('/')
        if not path: path = '/'
        user = self.get_user_from_token()
        if not user:
            self._set_headers(401)
            self.wfile.write(json.dumps({'error': 'Unauthorized'}).encode())
            return
            
        # Maintenance Guard for API
        if path.startswith('/api/') and path not in ['/api/auth/login']:
            if self.is_maintenance_active():
                if user.get('role') != 'admin':
                    self._set_headers(503)
                    self.wfile.write(json.dumps({'error': 'Maintenance Mode'}).encode())
                    return
            
        # Maintenance Guard for API
        if path.startswith('/api/') and path not in ['/api/auth/login']:
            if self.is_maintenance_active():
                if user.get('role') != 'admin':
                    self._set_headers(503)
                    self.wfile.write(json.dumps({'error': 'Maintenance Mode'}).encode())
                    return

        if path.startswith('/api/posts/'):
            post_id = path.split('/')[-1]
            conn = sqlite3.connect(DB_FILE, timeout=10)
            try:
                cursor = conn.cursor()
                cursor.execute("SELECT authorId FROM posts WHERE id = ?", (post_id,))
                post = cursor.fetchone()
                if not post:
                    self._set_headers(404); self.wfile.write(json.dumps({'error': 'Post not found'}).encode()); return
                if post[0] != user['user_id'] and user.get('role') not in ['admin', 'moderator']:
                    self._set_headers(403); self.wfile.write(json.dumps({'error': 'Forbidden'}).encode()); return
                cursor.execute("DELETE FROM post_likes WHERE post_id = ?", (post_id,))
                cursor.execute("DELETE FROM posts WHERE id = ?", (post_id,))
                conn.commit()
                self._set_headers()
                self.wfile.write(json.dumps({'message': 'Deleted'}).encode())
            finally:
                conn.close()

        elif path.startswith('/api/admin/users/'):
            if user.get('role') != 'admin':
                self._set_headers(403)
                return
            user_id = path.split('/')[-1]
            conn = sqlite3.connect(DB_FILE, timeout=10)
            try:
                cursor = conn.cursor()
                cursor.execute("DELETE FROM users WHERE id = ?", (user_id,))
                conn.commit()
                self._set_headers()
                self.wfile.write(json.dumps({'message': 'Deleted'}).encode())
            finally:
                conn.close()

        elif path.startswith('/api/feedback/'):
            feedback_id = path.split('/')[-1]
            
            # Check if user is authorized to delete feedback
            user = self.get_user_from_token()
            if not user:
                self._set_headers(401); self.wfile.write(json.dumps({'error': 'Unauthorized'}).encode()); return
            
            conn = sqlite3.connect(DB_FILE, timeout=10)
            try:
                cursor = conn.cursor()
                # Allow admin/moderator or the original submitter to delete
                cursor.execute("SELECT userId FROM site_feedback WHERE id = ?", (feedback_id,))
                feedback_owner_id = cursor.fetchone()
                if not feedback_owner_id or (feedback_owner_id[0] != user['user_id'] and user.get('role') not in ['admin', 'moderator']):
                    self._set_headers(403); self.wfile.write(json.dumps({'error': 'Forbidden. You can only delete your own feedback or if you are an admin/moderator.'}).encode()); return

                cursor.execute("DELETE FROM site_feedback WHERE id = ?", (feedback_id,))
                conn.commit()
                self._set_headers()
                self.wfile.write(json.dumps({'message': 'Feedback deleted'}).encode())
            finally:
                conn.close()

        elif path == '/api/profile':
            user = self.get_user_from_token()
            if not user:
                self._set_headers(401); return
            
            content_length = int(self.headers['Content-Length'])
            post_data = json.loads(self.rfile.read(content_length))
            password = post_data.get('password')

            conn = sqlite3.connect(DB_FILE, timeout=10)
            try:
                conn.row_factory = sqlite3.Row
                cursor = conn.cursor()
                cursor.execute("SELECT password FROM users WHERE id = ?", (user['user_id'],))
                user_row = cursor.fetchone()

                if user_row and bcrypt.checkpw(password.encode('utf-8'), user_row['password'].encode('utf-8')):
                        # Delete user's posts
                        cursor.execute("DELETE FROM posts WHERE authorId = ?", (user['user_id'],))
                        # Delete user's collections
                        cursor.execute("DELETE FROM collections WHERE authorId = ?", (user['user_id'],))
                        # Delete user account
                        cursor.execute("DELETE FROM users WHERE id = ?", (user['user_id'],))
                        conn.commit()
                        self._set_headers()
                        self.wfile.write(json.dumps({'message': 'Account and all associated data deleted'}).encode())
                else:
                    self._set_headers(401)
                    self.wfile.write(json.dumps({'error': 'Incorrect password'}).encode())
            finally:
                conn.close()

        else:
            self._set_headers(404)
            self.wfile.write(json.dumps({'error': 'Not found'}).encode())

    def do_POST(self):
        parsed_path = urlparse(self.path)
        path = parsed_path.path.rstrip('/')
        if not path: path = '/'
        content_length = int(self.headers.get('Content-Length', 0))
        try:
            if content_length:
                post_data = json.loads(self.rfile.read(content_length))
            else:
                post_data = {}
        except json.JSONDecodeError:
            self._set_headers(400)
            self.wfile.write(json.dumps({'error': 'Invalid JSON payload'}).encode())
            return
            
        # Maintenance Guard for API
        if path.startswith('/api/') and path not in ['/api/auth/login']:
            if self.is_maintenance_active():
                user = self.get_user_from_token()
                if not user or user.get('role') != 'admin':
                    self._set_headers(503); return

        if path == '/api/heartbeat':
            user = self.get_user_from_token()
            if not user:
                self._set_headers(401)
                return
            conn = sqlite3.connect(DB_FILE, timeout=10)
            try:
                cursor = conn.cursor()
                cursor.execute("UPDATE users SET last_seen = CURRENT_TIMESTAMP WHERE id = ?", (user['user_id'],))
                conn.commit()
                self._set_headers()
                self.wfile.write(json.dumps({'status': 'online'}).encode())
            finally:
                conn.close()
            return

        if path == '/api/auth/send-verification-code':
            email = post_data.get('email', '').lower().strip()
            username = post_data.get('username')
            password = post_data.get('password')
            gender = post_data.get('gender')
            bio = post_data.get('bio')

            if not email or not username or not password:
                self._set_headers(400)
                self.wfile.write(json.dumps({'error': 'Missing required fields'}).encode())
                return

            conn = sqlite3.connect(DB_FILE, timeout=10)
            try:
                cursor = conn.cursor()
                # Check if email or username already exists in active users
                cursor.execute("SELECT 1 FROM users WHERE email = ? OR username = ?", (email, username))
                if cursor.fetchone():
                    self._set_headers(409) # Conflict
                    self.wfile.write(json.dumps({'error': 'Email or username already registered.'}).encode())
                    return
                
                verification_code = ''.join(secrets.choice('0123456789') for _ in range(6))
                hashed_pw = bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')
                expires_at = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=15)).isoformat() # Code valid for 15 minutes

                try:
                    cursor.execute("""
                        INSERT INTO pending_verifications (email, code, username, password_hash, gender, bio, role, expires_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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

                    # Send the real email
                    subject = "Verify your BeyondFrame account"
                    body = f"Hello {username},\n\nYour 6-digit verification code is: {verification_code}\n\nThis code will expire in 15 minutes."
                    
                    if send_email(email, subject, body):
                        self._set_headers(200)
                        self.wfile.write(json.dumps({'message': 'Verification code sent.'}).encode())
                    else:
                        self._set_headers(500)
                        self.wfile.write(json.dumps({'error': 'Failed to send verification email.'}).encode())
                except Exception as e:
                    self._set_headers(500)
                    self.wfile.write(json.dumps({'error': f'Failed to send verification code: {str(e)}'}).encode())
            finally:
                conn.close()

        elif path == '/api/auth/verify-email':
            email = post_data.get('email', '').lower().strip()
            code = post_data.get('code')

            if not all([email, code]):
                self._set_headers(400)
                self.wfile.write(json.dumps({'error': 'Missing email or verification code'}).encode())
                return

            conn = sqlite3.connect(DB_FILE, timeout=10)
            try:
                conn.row_factory = sqlite3.Row
                cursor = conn.cursor()
                cursor.execute("SELECT * FROM pending_verifications WHERE email = ? AND code = ?", (email, code))
                pending_user = cursor.fetchone()

                if not pending_user:
                    self._set_headers(400)
                    self.wfile.write(json.dumps({'error': 'Invalid verification code or email.'}).encode())
                    return

                if datetime.datetime.now(datetime.timezone.utc) > datetime.datetime.fromisoformat(pending_user['expires_at']):
                    cursor.execute("DELETE FROM pending_verifications WHERE email = ?", (email,))
                    conn.commit()
                    self._set_headers(400)
                    self.wfile.write(json.dumps({'error': 'Verification code expired.'}).encode())
                    return
                
                # Check if this is the first user to register
                cursor.execute("SELECT COUNT(*) FROM users")
                role = 'admin' if cursor.fetchone()[0] == 0 else pending_user['role']

                try:
                    cursor.execute("INSERT INTO users (username, email, password, gender, bio, role) VALUES (?, ?, ?, ?, ?, ?)",
                                   (pending_user['username'], pending_user['email'], pending_user['password_hash'],
                                    pending_user['gender'], pending_user['bio'], role))
                    cursor.execute("DELETE FROM pending_verifications WHERE email = ?", (email,))
                    conn.commit()

                    # Generate token for the newly created user
                    new_user_id = cursor.lastrowid
                    token = jwt.encode({
                        'user_id': new_user_id, 'username': pending_user['username'], 'role': role,
                        'exp': datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=24)
                    }, SECRET_KEY, algorithm="HS256")

                    self._set_headers(201)
                    self.wfile.write(json.dumps({'message': 'Account created and verified.', 'token': token, 'username': pending_user['username'], 'role': role}).encode())
                except sqlite3.IntegrityError:
                    self._set_headers(409)
                    self.wfile.write(json.dumps({'error': 'Email or username already registered.'}).encode())
                except Exception as e:
                    self._set_headers(500)
                    self.wfile.write(json.dumps({'error': f'Failed to create account: {str(e)}'}).encode())
            finally:
                conn.close()

        elif path == '/api/auth/login':
            email = post_data.get('email', '').lower().strip()
            user = None
            conn = sqlite3.connect(DB_FILE, timeout=10)
            try:
                conn.row_factory = sqlite3.Row
                cursor = conn.cursor()
                cursor.execute("SELECT * FROM users WHERE LOWER(email) = ?", (email,))
                user = cursor.fetchone()

                if user and bcrypt.checkpw(post_data['password'].encode('utf-8'), user['password'].encode('utf-8')):
                    if user['is_blocked'] == 1:
                        self._set_headers(403)
                        self.wfile.write(json.dumps({'error': 'Your account has been blocked for guideline violations.'}).encode())
                        return
                    token = jwt.encode({
                        'user_id': user['id'], 'username': user['username'], 'role': user['role'],
                        'exp': datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=24)
                    }, SECRET_KEY, algorithm="HS256")
                    self._set_headers()
                    self.wfile.write(json.dumps({'token': token, 'username': user['username'], 'role': user['role']}).encode())
                else:
                    self._set_headers(401)
                    self.wfile.write(json.dumps({'error': 'Invalid email or password'}).encode())
            finally:
                conn.close()

        elif path == '/api/posts':
            user = self.get_user_from_token()
            if not user:
                self._set_headers(401)
                return
            
            # Verify user is not blocked before allowing post
            new_reviews_list = post_data.get('reviews', [])
            image_data_json = json.dumps(post_data.get('imageData', []))
            reviews_json = json.dumps(new_reviews_list)
            
            conn = sqlite3.connect(DB_FILE, timeout=10)
            try:
                conn.row_factory = sqlite3.Row
                cursor = conn.cursor()
                cursor.execute("SELECT is_blocked FROM users WHERE id = ?", (user['user_id'],))
                row = cursor.fetchone()
                if row and row[0] == 1:
                    self._set_headers(403)
                    self.wfile.write(json.dumps({'error': 'Blocked accounts cannot post content.'}).encode())
                    return

                # Notification Logic for Comments/Replies
                cursor.execute("SELECT authorId, reviews FROM posts WHERE id = ?", (post_data['id'],))
                old_post = cursor.fetchone()
                if old_post:
                    old_reviews = json.loads(old_post['reviews'] or '[]')
                    # Detect new top-level comment
                    if len(new_reviews_list) > len(old_reviews):
                        if old_post['authorId'] != user['user_id']:
                            # Deduplicate: Remove existing to prevent repeated notifications
                            cursor.execute("DELETE FROM notifications WHERE userId = ? AND type = ? AND actorName = ? AND postId = ?",
                                           (old_post['authorId'], 'comment', user['username'], post_data['id']))
                            cursor.execute("INSERT INTO notifications (userId, type, actorName, postId) VALUES (?, ?, ?, ?)",
                                           (old_post['authorId'], 'comment', user['username'], post_data['id']))
                    # Detect deleted top-level comment
                    elif len(new_reviews_list) < len(old_reviews):
                        cursor.execute("DELETE FROM notifications WHERE userId = ? AND type = ? AND actorName = ? AND postId = ?",
                                       (old_post['authorId'], 'comment', user['username'], post_data['id']))
                    # Detect changes in replies
                    elif len(new_reviews_list) == len(old_reviews):
                        for i in range(len(new_reviews_list)):
                            new_reps = new_reviews_list[i].get('replies', [])
                            old_reps = old_reviews[i].get('replies', [])
                            if len(new_reps) > len(old_reps):
                                target_uid = old_reviews[i].get('authorId')
                                if target_uid and target_uid != user['user_id']:
                                    # Deduplicate
                                    cursor.execute("DELETE FROM notifications WHERE userId = ? AND type = ? AND actorName = ? AND postId = ?",
                                                   (target_uid, 'reply', user['username'], post_data['id']))
                                    cursor.execute("INSERT INTO notifications (userId, type, actorName, postId) VALUES (?, ?, ?, ?)",
                                                   (target_uid, 'reply', user['username'], post_data['id']))
                            elif len(new_reps) < len(old_reps):
                                target_uid = old_reviews[i].get('authorId')
                                if target_uid:
                                    cursor.execute("DELETE FROM notifications WHERE userId = ? AND type = ? AND actorName = ? AND postId = ?",
                                                   (target_uid, 'reply', user['username'], post_data['id']))

                cursor.execute("""
                    INSERT OR REPLACE INTO posts (id, title, description, author, authorId, imageData, reviews) 
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                """, (post_data['id'], post_data['title'], post_data['description'], user['username'], user['user_id'],
                    image_data_json, reviews_json))
                conn.commit()
                self._set_headers(201)
                self.wfile.write(json.dumps({'message': 'Post saved'}).encode())
            finally:
                conn.close()

        elif path == '/api/posts/toggle-like':
            user = self.get_user_from_token()
            if not user:
                self._set_headers(401)
                self.wfile.write(json.dumps({'error': 'Session expired. Please log in again.'}).encode())
                return
            
            post_id = post_data.get('postId')
            if not post_id:
                self._set_headers(400)
                self.wfile.write(json.dumps({'error': 'Missing postId'}).encode())
                return

            conn = sqlite3.connect(DB_FILE, timeout=10)
            try:
                cursor = conn.cursor()
                
                # 1. Check if user already liked this post
                cursor.execute("SELECT 1 FROM post_likes WHERE post_id = ? AND user_id = ?", (post_id, user['user_id']))
                exists = cursor.fetchone()
                
                # 2. Get post author for notification purposes
                cursor.execute("SELECT authorId FROM posts WHERE id = ?", (post_id,))
                post_row = cursor.fetchone()
                if not post_row:
                    self._set_headers(404)
                    self.wfile.write(json.dumps({'error': 'Post not found'}).encode())
                    return
                author_id = post_row[0]

                if exists:
                    # Unliking logic
                    cursor.execute("DELETE FROM post_likes WHERE post_id = ? AND user_id = ?", (post_id, user['user_id']))
                    cursor.execute("DELETE FROM notifications WHERE userId = ? AND type = ? AND actorName = ? AND postId = ?",
                                   (author_id, 'like', user['username'], post_id))
                    status = "unliked"
                else:
                    # Liking logic
                    cursor.execute("INSERT INTO post_likes (post_id, user_id) VALUES (?, ?)", (post_id, user['user_id']))
                    status = "liked"
                    if author_id != user['user_id']:
                        # Deduplicate and Notify author if not self
                        cursor.execute("DELETE FROM notifications WHERE userId = ? AND type = ? AND actorName = ? AND postId = ?",
                                       (author_id, 'like', user['username'], post_id))
                        cursor.execute("INSERT INTO notifications (userId, type, actorName, postId) VALUES (?, ?, ?, ?)",
                                       (author_id, 'like', user['username'], post_id))
                conn.commit()

                self._set_headers()
                self.wfile.write(json.dumps({'status': status}).encode())
            except Exception as e:
                if DEBUG_MODE: print(f"❌ Like Toggle Error: {str(e)}")
                self._set_headers(500)
                self.wfile.write(json.dumps({'error': 'Internal server error during like toggle.'}).encode())
            finally:
                conn.close()

        elif path == '/api/collections':
            user = self.get_user_from_token()
            if not user:
                self._set_headers(401); return
            
            post_ids_json = json.dumps(post_data.get('postIds', []))
            conn = sqlite3.connect(DB_FILE, timeout=10)
            try:
                cursor = conn.cursor()
                cursor.execute("""
                    INSERT INTO collections (name, postIds, authorId) VALUES (?, ?, ?)
                    ON CONFLICT(name, authorId) DO UPDATE SET postIds = excluded.postIds
                """, (post_data['name'], post_ids_json, user['user_id']))
                conn.commit()
                self._set_headers()
                self.wfile.write(json.dumps({'message': 'Saved'}).encode())
            finally:
                conn.close()

        elif path == '/api/notifications/read':
            user = self.get_user_from_token()
            if not user:
                self._set_headers(401); return
            
            conn = sqlite3.connect(DB_FILE, timeout=10)
            try:
                cursor = conn.cursor()
                cursor.execute("UPDATE notifications SET isRead = 1 WHERE userId = ?", (user['user_id'],))
                conn.commit()
                self._set_headers()
                self.wfile.write(json.dumps({'message': 'Notifications marked as read'}).encode())
            finally:
                conn.close()

        elif path == '/api/feedback':
            user = self.get_user_from_token()
            if not user:
                self._set_headers(401)
                self.wfile.write(json.dumps({'error': 'Unauthorized'}).encode())
                return
            
            # Check if feedback is enabled for non-admins
            conn = sqlite3.connect(DB_FILE, timeout=10)
            try:
                cursor = conn.cursor()
                cursor.execute("SELECT value FROM settings WHERE key = 'feedback_enabled'")
                row = cursor.fetchone()
                is_enabled = row[0] == '1' if row else True
                if not is_enabled and user.get('role') not in ['admin', 'moderator']:
                    self._set_headers(403)
                    self.wfile.write(json.dumps({'error': 'Feedback system is currently disabled by administrator.'}).encode())
                    return
            finally:
                conn.close()

            content = post_data.get('content')
            f_type = post_data.get('type', 'feedback')
            if not content:
                self._set_headers(400); return

            conn = sqlite3.connect(DB_FILE, timeout=10)
            try:
                cursor = conn.cursor()
                cursor.execute("INSERT INTO site_feedback (userId, username, content, type) VALUES (?, ?, ?, ?)",
                               (user['user_id'], user['username'], content, f_type))
                conn.commit()
                self._set_headers(201)
                self.wfile.write(json.dumps({'message': 'Feedback submitted'}).encode())
            finally:
                conn.close()

        elif path == '/api/profile/change-password':
            user = self.get_user_from_token()
            if not user:
                self._set_headers(401); return
            
            old_pwd = post_data.get('oldPassword')
            new_pwd = post_data.get('newPassword')
            
            conn = sqlite3.connect(DB_FILE, timeout=10)
            try:
                conn.row_factory = sqlite3.Row
                cursor = conn.cursor()
                cursor.execute("SELECT password FROM users WHERE id = ?", (user['user_id'],))
                user_row = cursor.fetchone()
                
                if user_row and bcrypt.checkpw(old_pwd.encode('utf-8'), user_row['password'].encode('utf-8')):
                    hashed_new = bcrypt.hashpw(new_pwd.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')
                    cursor.execute("UPDATE users SET password = ? WHERE id = ?", (hashed_new, user['user_id']))
                    conn.commit()
                    self._set_headers()
                    self.wfile.write(json.dumps({'message': 'Password updated'}).encode())
                else:
                    self._set_headers(401)
                    self.wfile.write(json.dumps({'error': 'Incorrect current password'}).encode())
            finally:
                conn.close()

        elif path == '/api/admin/settings/feedback-toggle':
            if user.get('role') != 'admin':
                self._set_headers(403); return
            content_length = int(self.headers['Content-Length'])
            data = json.loads(self.rfile.read(content_length))
            enabled_val = '1' if data.get('enabled') else '0'
            conn = sqlite3.connect(DB_FILE, timeout=10)
            try:
                cursor = conn.cursor()
                cursor.execute("UPDATE settings SET value = ? WHERE key = 'feedback_enabled'", (enabled_val,))
                conn.commit()
                self._set_headers()
                self.wfile.write(json.dumps({'message': 'Setting updated'}).encode())
            finally:
                conn.close()
            return

        elif path == '/api/profile/reset-auth':
            user = self.get_user_from_token()
            if not user:
                self._set_headers(401); return
            
            pwd = post_data.get('password')
            conn = sqlite3.connect(DB_FILE, timeout=10)
            try:
                conn.row_factory = sqlite3.Row
                cursor = conn.cursor()
                cursor.execute("SELECT password FROM users WHERE id = ?", (user['user_id'],))
                user_row = cursor.fetchone()
                if user_row and bcrypt.checkpw(pwd.encode('utf-8'), user_row['password'].encode('utf-8')):
                    self._set_headers()
                    self.wfile.write(json.dumps({'message': 'Authenticated'}).encode())
                else:
                    self._set_headers(401)
                    self.wfile.write(json.dumps({'error': 'Incorrect password'}).encode())
            finally:
                conn.close()
        
        elif path == '/api/auth/send-password-reset-code':
            email = post_data.get('email', '').lower().strip()
            if not email:
                self._set_headers(400)
                self.wfile.write(json.dumps({'error': 'Email is required'}).encode())
                return
            
            conn = sqlite3.connect(DB_FILE, timeout=10)
            try:
                cursor = conn.cursor()
                cursor.execute("SELECT 1 FROM users WHERE LOWER(email) = ?", (email,))
                if not cursor.fetchone():
                    self._set_headers(404)
                    self.wfile.write(json.dumps({'error': 'User with this email not found'}).encode())
                    return
                
                reset_code = ''.join(secrets.choice('0123456789') for _ in range(6))
                expires_at = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=15)).isoformat() # Code valid for 15 minutes
                
                cursor.execute("""
                    INSERT INTO password_resets (email, code, expires_at)
                    VALUES (?, ?, ?)
                    ON CONFLICT(email) DO UPDATE SET
                        code = excluded.code,
                        expires_at = excluded.expires_at
                """, (email, reset_code, expires_at))
                conn.commit()
                
                subject = "BeyondFrame Password Reset Code"
                body = f"Your password reset code is: {reset_code}\n\nThis code will expire in 15 minutes."
                if send_email(email, subject, body):
                    self._set_headers(200)
                    self.wfile.write(json.dumps({'message': 'Password reset code sent to your email.'}).encode())
                else:
                    self._set_headers(500)
                    self.wfile.write(json.dumps({'error': 'Failed to send reset code email.'}).encode())
            finally:
                conn.close()

        elif path == '/api/auth/reset-password':
            email = post_data.get('email', '').lower().strip()
            code = post_data.get('code')
            new_password = post_data.get('newPassword')
            
            if not all([email, code, new_password]):
                self._set_headers(400)
                self.wfile.write(json.dumps({'error': 'Missing email, code, or new password'}).encode())
                return
            
            conn = sqlite3.connect(DB_FILE, timeout=10)
            try:
                cursor = conn.cursor()
                cursor.execute("SELECT expires_at FROM password_resets WHERE email = ? AND code = ?", (email, code))
                reset_entry = cursor.fetchone()
                
                if not reset_entry or datetime.datetime.now(datetime.timezone.utc) > datetime.datetime.fromisoformat(reset_entry[0]):
                    self._set_headers(400)
                    self.wfile.write(json.dumps({'error': 'Invalid or expired reset code.'}).encode())
                    return
                
                hashed_new = bcrypt.hashpw(new_password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')
                cursor.execute("UPDATE users SET password = ? WHERE LOWER(email) = ?", (hashed_new, email))
                cursor.execute("DELETE FROM password_resets WHERE email = ?", (email,))
                conn.commit()
                self._set_headers(200)
                self.wfile.write(json.dumps({'message': 'Password has been reset successfully.'}).encode())
            finally:
                conn.close()

        else:
            self._set_headers(404)
            self.wfile.write(json.dumps({'error': 'Not found'}).encode())

    def do_PATCH(self):
        parsed_path = urlparse(self.path)
        path = parsed_path.path.rstrip('/')
        if not path: path = '/'
        user = self.get_user_from_token()
        if not user:
            self._set_headers(403)
            return

        if path == '/api/profile/avatar':
            content_length = int(self.headers['Content-Length'])
            data = json.loads(self.rfile.read(content_length))
            conn = sqlite3.connect(DB_FILE, timeout=10)
            try:
                cursor = conn.cursor()
                cursor.execute("UPDATE users SET profile_pic = ? WHERE id = ?", (data.get('profile_pic'), user['user_id']))
                conn.commit()
                self._set_headers()
                self.wfile.write(json.dumps({'message': 'Avatar updated'}).encode())
            finally:
                conn.close()
            return

        if path.startswith('/api/admin/users/') and path.endswith('/role'):
            if user.get('role') != 'admin':
                self._set_headers(403)
                return
            user_id = path.split('/')[-2]
            content_length = int(self.headers['Content-Length'])
            data = json.loads(self.rfile.read(content_length))
            
            conn = sqlite3.connect(DB_FILE, timeout=10)
            try:
                cursor = conn.cursor()
                cursor.execute("UPDATE users SET role = ? WHERE id = ?", (data['role'], user_id))
                conn.commit()
                self._set_headers()
                self.wfile.write(json.dumps({'message': 'Updated'}).encode())
            finally:
                conn.close()
        elif path == '/api/admin/settings/maintenance-toggle':
            if user.get('role') != 'admin':
                self._set_headers(403); return
            content_length = int(self.headers['Content-Length'])
            data = json.loads(self.rfile.read(content_length))
            enabled_val = '1' if data.get('enabled') else '0'
            conn = sqlite3.connect(DB_FILE, timeout=10)
            try:
                cursor = conn.cursor()
                cursor.execute("UPDATE settings SET value = ? WHERE key = 'maintenance_mode'", (enabled_val,))
                conn.commit()
                self._set_headers()
                self.wfile.write(json.dumps({'message': 'Maintenance mode updated'}).encode())
            finally:
                conn.close()
            return
        elif path.startswith('/api/admin/users/') and path.endswith('/block'):
            if user.get('role') != 'admin':
                self._set_headers(403)
                return
            user_id = path.split('/')[-2]
            content_length = int(self.headers['Content-Length'])
            data = json.loads(self.rfile.read(content_length))
            
            conn = sqlite3.connect(DB_FILE, timeout=10)
            try:
                cursor = conn.cursor()
                cursor.execute("UPDATE users SET is_blocked = ? WHERE id = ?", (data['is_blocked'], user_id))
                conn.commit()
                self._set_headers()
                self.wfile.write(json.dumps({'message': 'User Status Updated'}).encode())
            finally:
                conn.close()
        else:
            self._set_headers(404)

def run(server_class=ThreadedHTTPServer, handler_class=RequestHandler):
    init_db()
    
    # Check for environment PORT (standard for cloud hosting) 
    # or fall back to local scanning
    port = int(os.environ.get('PORT', 0))
    if not port:
        port = 8000
        for p in range(8000, 8010):
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                if s.connect_ex(('localhost', p)) != 0:
                    port = p
                    break
    
    print("Attempting to start HTTP server...")
    server_address = ('', port)
    httpd = server_class(server_address, handler_class)
    print(f"🚀 BeyondFrame Server listening on http://localhost:{port}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n🛑 Shutting down server...")
        httpd.server_close()

if __name__ == '__main__':
    run()