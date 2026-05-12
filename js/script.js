// Immediate theme check to prevent flash
(function() {
  const savedTheme = localStorage.getItem('bf_theme');
  if (savedTheme === 'light') document.body.classList.add('light-mode');
})();

// Register Service Worker for PWA support
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('js/service-worker.js', { scope: '/' });
  });
}

// Database settings
// Detects if we are running locally or hosted to set the correct API URL
const API_PROTOCOL = window.location.protocol;
const API_PORT = window.location.port || (window.location.hostname === 'localhost' ? '8000' : '');
const API_URL = `${API_PROTOCOL}//${window.location.hostname}${API_PORT ? ':' + API_PORT : ''}/api`;

window.currentAuthorFilter = null;
window.cachedPosts = [];

function getAuthHeaders() {
  const token = localStorage.getItem('bf_token');
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  };
}

// Function to load configuration from the json folder
async function loadConfig() {
  try {
    const response = await fetch('json/config.json');
    if (!response.ok) throw new Error('Failed to load config.json');
    const config = await response.json();
    console.log('Project Configuration Loaded:', config);
    return config;
  } catch (error) {
    console.error('Config Error:', error);
  }
}

// Initializes the UI and Theme (Legacy name kept for HTML compatibility)
async function openDatabase() {
  injectModals();
  initTheme();
  loadAdminStats();

  // Start heartbeat to track "Active" status
  if (localStorage.getItem('bf_token')) {
    setInterval(async () => {
      fetch(`${API_URL}/heartbeat`, { method: 'POST', headers: getAuthHeaders() })
        .catch(() => {}); // Silently fail if server is down
    }, 30000); // Ping every 30 seconds
  }

  window.db = "SERVER_MODE"; // Signal to forms that the system is ready
  return Promise.resolve();
}

// Function to get all the photos we saved
async function getAllPosts() {
  const response = await fetch(`${API_URL}/posts?t=${Date.now()}`, { headers: getAuthHeaders() });
  if (!response.ok) return [];
  return response.json();
}

// Functions to handle Collections (Groups)
async function getAllCollections() {
  const response = await fetch(`${API_URL}/collections`, { headers: getAuthHeaders() });
  if (!response.ok) return [];
  return response.json();
}

async function updateCollection(collection) {
  await fetch(`${API_URL}/collections`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify(collection)
  });
}

// Function to save a new photo post
async function addPost(post) {
  // Convert only actual File Blobs to Base64; keep existing strings as-is
  const imageData = await Promise.all(post.imageData.map(async (item) => {
    if (item instanceof Blob) return await readFileAsDataURL(item);
    return item;
  }));

  const response = await fetch(`${API_URL}/posts`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ ...post, imageData })
  });
  return response.json();
}

// Function to remove a photo by its ID
async function deletePost(postId) {
  const response = await fetch(`${API_URL}/posts/${postId}`, {
    method: 'DELETE',
    headers: getAuthHeaders()
  });
  if (!response.ok) throw new Error('Failed to delete post');
}

// Utility to compress images before saving to IndexedDB
async function compressImage(file, maxWidth = 1600, quality = 0.7) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = (event) => {
      const img = new Image();
      img.src = event.target.result;
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let width = img.width;
        let height = img.height;

        if (width > maxWidth) {
          height = (maxWidth / width) * height;
          width = maxWidth;
        }

        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        
        canvas.toBlob((blob) => {
          // Return a new File object so metadata is preserved if needed
          const compressedFile = new File([blob], file.name, { type: 'image/jpeg' });
          resolve(compressedFile);
        }, 'image/jpeg', quality);
      };
    };
  });
}

// Helper function to turn a file from the computer into a string of text (Base64)
function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function getCurrentUser() {
  const token = localStorage.getItem('bf_token');
  if (token) {
    const payload = parseJwt(token);
    if (payload && payload.username) {
      return payload.username;
    }
  }
  return localStorage.getItem('bf_username') || null;
}

// Utility to escape HTML and prevent tag breaking
window.escapeHTML = function(str) {
  if (!str) return "";
  return String(str).replace(/[&<>"']/g, function(m) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m];
  });
};

window.getRelativeTime = function(ts) {
  const time = parseInt(ts);
  if (!time || time < 1000000000) return "";
  const diff = Date.now() - time;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return mins + "m ago";
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + "h ago";
  return Math.floor(hrs / 24) + "d ago";
};

// Global helper to safely resolve an image URL from strings or Blobs
window.resolveImgUrl = function(data) {
  if (!data) return '';
  if (data instanceof Blob) return URL.createObjectURL(data);
  
  let str = data;
  if (Array.isArray(str)) return window.resolveImgUrl(str[0]);
  if (typeof str !== 'string') return '';

  str = str.trim();
  try {
    // Only attempt to parse if it explicitly looks like JSON to avoid performance hits or corruption
    if ((str.startsWith('"') && str.endsWith('"')) || (str.startsWith('[') && str.endsWith(']')) || (str.startsWith('"{') && str.endsWith('}"'))) {
      const parsed = JSON.parse(str);
      return window.resolveImgUrl(parsed);
    }
  } catch(e) {
    // Fallback: manually strip surrounding quotes if it's not valid JSON
    if (str.startsWith('"') && str.endsWith('"')) {
        str = str.slice(1, -1).trim();
    }
  }

  return typeof str === 'string' ? str.trim() : '';
};

// Moved from profile.html to be globally accessible
function openLogoutModal() {
  console.log("openLogoutModal called.");
  const modalElement = document.getElementById('logout-confirm-modal');
  if (modalElement) {
    console.log("Logout modal element found. Displaying modal.");
    modalElement.classList.remove('hidden');
  } else {
    console.error("Error: Logout modal element with ID 'logout-confirm-modal' not found in the DOM.");
    showToast("Internal error: Logout confirmation modal not found. Please refresh the page.", "error");
  }
}

function closeLogoutModal() {
  document.getElementById('logout-confirm-modal').classList.add('hidden');
  console.log("closeLogoutModal called.");
}

// This function is called by the "Yes, Logout" button in the custom modal
function performLogout(force = false) {
  closeLogoutModal(); // Close the modal first
  window.logout(force); // Call the global logout function
  console.log("performLogout called, initiating window.logout with force=true.");
}

window.logout = function(force = false) { // 'force' is used for system-triggered logouts (e.g., after account deletion)
  if (force === true) {
    localStorage.removeItem('bf_token');
    localStorage.removeItem('bf_username');
    localStorage.removeItem('bf_role');
    window.location.href = 'index.html';
  } else {
    // Open the custom logout confirmation modal
    console.log("window.logout called without force. Attempting to open confirmation modal.");
    openLogoutModal();
  }
};

function parseJwt(token) {
  try {
    return JSON.parse(atob(token.split('.')[1]));
  } catch (e) { return null; }
}

// Theme Management
function initTheme() {
  const savedTheme = localStorage.getItem('bf_theme');
  if (savedTheme === 'light') {
    document.body.classList.add('light-mode');
  }
  initLogoSound();
  updateNavRoles();
  injectThemeToggle();
}

function updateNavRoles() {
  const token = localStorage.getItem('bf_token');
  const nav = document.querySelector('nav');
  if (!nav) return;

  if (!token) {
    if (window.location.pathname.endsWith('auth.html')) return;
    // Add Login link for guests if not already present
    if (!document.querySelector('a[href="auth.html"]')) {
      nav.insertAdjacentHTML('beforeend', '<a href="auth.html">Login</a>');
    }
    return;
  }

  const payload = parseJwt(token);
  if (payload && nav) {
    // Remove guest login link if it exists
    const guestLogin = document.querySelector('a[href="auth.html"]');
    if (guestLogin) guestLogin.remove();

    if (payload.role === 'admin' && !document.querySelector('a[href="admin.html"]')) {
      nav.insertAdjacentHTML('beforeend', '<a href="admin.html">Admin</a>');
    }
    if ((payload.role === 'moderator' || payload.role === 'admin') && !document.querySelector('a[href="moderator.html"]')) {
      nav.insertAdjacentHTML('beforeend', '<a href="moderator.html">Mod</a>');
    }
    // Add Profile link if not present
    if (!document.querySelector('a[href="profile.html"]')) {
      nav.insertAdjacentHTML('beforeend', '<a href="profile.html">Profile</a>');
    }

    // Add Notification Bell
    if (!document.getElementById('nav-notifications-btn')) {
      const bellHTML = `
        <button id="nav-notifications-btn" class="theme-toggle" onclick="openNotificationsModal()" style="position:relative; margin-left: 0.5rem;" title="Notifications">
          <svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
            <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path>
            <path d="M13.73 21a2 2 0 0 1-3.46 0"></path>
          </svg>
          <span id="nav-note-badge" class="hidden" style="position:absolute; top:-5px; right:-5px; background:#ff4d4d; color:white; font-size:10px; padding:2px 5px; border-radius:10px; border:2px solid var(--bg-color);">0</span>
        </button>`;
      nav.insertAdjacentHTML('beforeend', bellHTML);
      fetchNotificationsCount();
      // Poll for new notifications every 30 seconds
      setInterval(fetchNotificationsCount, 30000);
    }
  }
}

// Global Audio Context to handle browser autoplay restrictions
let audioCtx = null;

function initAudioContext() {
  if (audioCtx) return audioCtx;
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return null;
  audioCtx = new AudioContext();
  return audioCtx;
}

// Unlock audio context on user interaction
window.addEventListener('click', () => {
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
}, { once: true });

function initLogoSound() {
  const logo = document.querySelector('.header-logo');
  if (logo) {
    logo.addEventListener('click', () => {
      initAudioContext();
      playShutterSound();
    });
  }
}

function playShutterSound() {
  const ctx = initAudioContext();
  if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume();
  
  const playNoise = (time, duration, freq, volume) => {
    const buffer = ctx.createBuffer(1, ctx.sampleRate * duration, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(freq, time);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(volume, time);
    gain.gain.exponentialRampToValueAtTime(0.01, time + duration);
    source.connect(filter).connect(gain).connect(ctx.destination);
    source.start(time);
  };

  playNoise(ctx.currentTime, 0.05, 1000, 0.1); // Mirror flip
  playNoise(ctx.currentTime + 0.05, 0.1, 500, 0.2); // Shutter curtain
}

function playNotificationSound() {
  const ctx = initAudioContext();
  if (!ctx || ctx.state === 'suspended') return;
  
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  
  osc.type = 'sine';
  osc.frequency.setValueAtTime(1046.50, ctx.currentTime); // C6 - clean aesthetic ping
  
  gain.gain.setValueAtTime(0, ctx.currentTime);
  gain.gain.linearRampToValueAtTime(0.1, ctx.currentTime + 0.01); // Fast attack
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6); // Smooth decay
  
  osc.connect(gain);
  gain.connect(ctx.destination);
  
  osc.start();
  osc.stop(ctx.currentTime + 0.6);
}

function injectThemeToggle() {
  const nav = document.querySelector('.site-header nav');
  if (!nav || document.getElementById('theme-toggle')) return;

  const toggle = document.createElement('button');
  toggle.id = 'theme-toggle';
  toggle.className = 'theme-toggle';
  toggle.title = 'Toggle Light/Dark Mode';
  toggle.setAttribute('aria-label', 'Toggle theme');
  
  const updateIcon = () => {
    const isLight = document.body.classList.contains('light-mode');
    toggle.innerHTML = isLight ? '🌙' : '☀️';
  };

  updateIcon();

  toggle.onclick = () => {
    const isLight = document.body.classList.toggle('light-mode');
    localStorage.setItem('bf_theme', isLight ? 'light' : 'dark');
    updateIcon();
  };

  nav.appendChild(toggle);
}

// Password Reset API Helpers
window.resetEmail = '';

window.apiSendResetCode = async function(email) {
  window.resetEmail = email;
  showToast('Sending reset code...', 'info');
  try {
    const res = await fetch(`${API_URL}/auth/send-password-reset-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    const data = await res.json().catch(() => ({ error: 'Invalid server response' }));
    if (res.ok) {
      showToast('Code sent to your email!', 'success');
      return true;
    } else {
      showToast(data.error || 'Failed to send code', 'error');
      return false;
    }
  } catch (err) {
    showToast('Network error', 'error');
    return false;
  }
};

window.apiResetPassword = async function(email, code, newPassword) {
  try {
    const res = await fetch(`${API_URL}/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, code, newPassword })
    });
    const data = await res.json().catch(() => ({ error: 'Invalid server response' }));
    if (res.ok) {
      showToast('Password reset successful!', 'success');
      return true;
    } else {
      showToast(data.error || 'Reset failed', 'error');
      return false;
    }
  } catch (err) {
    showToast('Network error', 'error');
    return false;
  }
};

// Inject Modals to avoid HTML duplication across pages
function injectModals() {
  if (document.getElementById('modal')) return;

  const modalHTML = `
    <div id="modal" class="modal hidden">
      <div class="modal-overlay" onclick="closeModal()"></div>
      <div class="modal-content">
        <button class="modal-close" onclick="closeModal()">&times;</button>
        <div class="modal-image-container">
          <button id="modal-prev" class="slider-nav-btn prev hidden" onclick="modalPrev()">‹</button>
          <button id="modal-next" class="slider-nav-btn next hidden" onclick="modalNext()">›</button>
          <div id="modal-counter" class="image-counter hidden"></div>
          <img id="modal-image" src="" alt="">
        </div>
        <div class="modal-details">
          <div class="modal-actions-bar">
            <div class="modal-action-group">
              <button id="modal-like" class="action-btn">🤍 0</button>
              <button id="modal-save" class="action-btn">
                <svg class="bookmark-icon" viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path>
                </svg>
              </button>
              <div style="position: relative; display: flex; align-items: center;">
                <button class="menu-btn" onclick="toggleModalMenu(event)">···</button>
                <div id="modal-menu-dropdown" class="menu-dropdown" style="top: auto; bottom: calc(100% + 10px); left: 50%; transform: translateX(-50%); right: auto;">
                  <button id="modal-edit-btn" onclick="editPostFromModal()">Edit</button>
                  <button onclick="sharePostFromModal()">Share</button>
                  <a id="modal-download" class="download-link" href="" download>Download</a>
                  <button id="modal-delete-btn" onclick="deletePostFromModal()" style="color:#ff4d4d">Delete</button>
                </div>
              </div>
            </div>
          </div>
          <div class="modal-comments-section">
            <h4>Recent Reviews</h4>
            <div class="comment-input-area" style="margin-bottom: 1.5rem;">
              <input type="text" id="modal-comment-input" placeholder="Add a review..." onkeydown="if(event.key === 'Enter') submitCommentFromModal()" />
              <button class="button" onclick="submitCommentFromModal()">Post</button>
            </div>
            <div id="modal-comments-list"></div>
          </div>
          <div class="modal-header-row" style="margin-top: 2rem; border-top: 1px solid var(--border-color); padding-top: 1.5rem;">
            <div id="modal-meta" class="modal-meta"></div>
            <h3 id="modal-title"></h3>
          </div>
          <p id="modal-description"></p>
        </div>
      </div>
    </div>

    <div id="comment-modal" class="modal hidden">
      <div class="modal-overlay" onclick="closeCommentModal()"></div>
      <div class="modal-content comment-modal-content">
        <button class="modal-close" onclick="closeCommentModal()">&times;</button>
        <div class="modal-details">
          <h3>Reviews</h3>
          <div class="comment-input-area" style="margin-bottom: 2rem;">
            <input type="text" id="modal-comment-input-bulk" placeholder="Add a review..." onkeydown="if(event.key === 'Enter') submitReviewFromModal()" />
            <button class="button" onclick="submitReviewFromModal()">Post</button>
          </div>
          <div id="modal-comments-container" class="comments-container"></div>
        </div>
      </div>
    </div>

    <div id="save-modal" class="modal hidden">
      <div class="modal-overlay" onclick="closeSaveModal()"></div>
      <div class="modal-content" style="max-width: 400px;">
        <button class="modal-close" onclick="closeSaveModal()">&times;</button>
        <div class="modal-details">
          <h3>Save to Collection</h3>
          <div id="collection-list" style="margin-bottom: 1.5rem;"></div>
          <div class="comment-input-area" style="flex-direction: column;">
            <input type="text" id="new-group-name" placeholder="New group name..." onkeydown="if(event.key === 'Enter') createNewGroupAndSave()" />
            <button class="button" onclick="createNewGroupAndSave()">Create & Save</button>
          </div>
        </div>
      </div>
    </div>

    <div id="big-screen-overlay" class="modal hidden">
      <div class="modal-overlay" onclick="closeBigScreen()"></div>
      <div class="modal-content">
        <button class="modal-close" onclick="closeBigScreen()">&times;</button>
        <div class="modal-image-container">
          <button class="slider-nav-btn prev" onclick="modalPrev()">‹</button>
          <button class="slider-nav-btn next" onclick="modalNext()">›</button>
          <div class="image-counter"></div>
          <img id="big-screen-image" src="" alt="">
        </div>
      </div>
    </div>

    <div id="logout-confirm-modal" class="modal hidden">
      <div class="modal-overlay" onclick="closeLogoutModal()"></div>
      <div class="modal-content" style="max-width: 400px; text-align: center;">
        <div class="modal-details">
          <h3>Confirm Logout</h3>
          <p>Are you sure you want to log out of BeyondFrame?</p>
          <div style="display: flex; gap: 1rem; margin-top: 2rem;">
            <button class="button" style="flex: 1; background: var(--bg-color); border: 1px solid var(--border-color); color: var(--text-color);" onclick="closeLogoutModal()">Cancel</button>
            <button class="button" style="flex: 1; background: #ff4d4d; color: white;" onclick="performLogout(true)">Yes, Logout</button>
          </div>
        </div>
      </div>
    </div>

    <div id="notifications-modal" class="modal hidden">
      <div class="modal-overlay" onclick="closeNotificationsModal()"></div>
      <div class="modal-content" style="max-width: 450px;">
        <button class="modal-close" onclick="closeNotificationsModal()">&times;</button>
        <div class="modal-details">
          <h3>Notifications</h3>
          <div id="notifications-list" style="margin-top: 1rem; max-height: 400px; overflow-y: auto;">
            <p style="opacity: 0.6; font-style: italic;">Loading...</p>
          </div>
          <button class="button" style="width: 100%; margin-top: 1.5rem;" onclick="markAllNotesRead()">Mark all as read</button>
        </div>
      </div>
    </div>

    <div id="delete-account-modal" class="modal hidden">
      <div class="modal-overlay" onclick="closeDeleteAccountModal()"></div>
      <div class="modal-content" style="max-width: 400px; text-align: center;">
        <div class="modal-details">
          <h3 style="color: #ff4d4d;">Delete Account</h3>
          <p>This action is <strong>irreversible</strong> and will remove all your data. Please enter your password to confirm.</p>
          <div class="form-group" style="margin-top: 1.5rem; text-align: left;">
            <label>Confirm Password</label>
            <input type="password" id="delete-confirm-password" placeholder="Enter your password" style="width: 100%;" />
          </div>
          <div style="display: flex; gap: 1rem; margin-top: 2rem;">
            <button class="button" style="flex: 1; background: var(--bg-color); border: 1px solid var(--border-color); color: var(--text-color);" onclick="closeDeleteAccountModal()">Cancel</button>
            <button class="button" style="flex: 1; background: #ff4d4d; color: white;" onclick="processAccountDeletion()">Delete Forever</button>
          </div>
        </div>
      </div>
    </div>

    <div id="email-prompt-modal" class="modal hidden">
      <div class="modal-overlay" onclick="closeEmailPromptModal()"></div>
      <div class="modal-content password-reset-card">
        <button class="modal-close" onclick="closeEmailPromptModal()">&times;</button>
        <h3 style="text-align: center; margin-top: 0;">Reset Your Password</h3>
        <p style="text-align: center; font-size: 0.9rem; opacity: 0.8;">Enter your email to receive a password reset code.</p>
        <form id="email-prompt-form" onsubmit="sendResetCodeEmail(event)">
          <div class="form-group">
            <label for="reset-email-prompt">Email</label>
            <input type="email" id="reset-email-prompt" placeholder="your@email.com" required />
          </div>
          <button type="submit" class="auth-button">Send Reset Code</button>
        </form>
      </div>
    </div>

    <div id="reset-password-modal" class="modal hidden">
      <div class="modal-overlay" onclick="closeResetPasswordModal()"></div>
      <div class="modal-content password-reset-card">
        <button class="modal-close" onclick="closeResetPasswordModal()">&times;</button>
        <h3 style="text-align: center; margin-top: 0;">Set New Password</h3>
        <p style="text-align: center; font-size: 0.9rem; opacity: 0.8;">Enter the code sent to your email and your new password.</p>
        <form id="password-reset-form" onsubmit="resetPassword(event)">
          <div class="form-group">
            <label>Email</label>
            <input type="email" id="reset-email" required readonly />
          </div>
          <div class="form-group">
            <label>Verification Code</label>
            <input type="text" id="reset-code" placeholder="6-digit code" required maxlength="6" />
          </div>
          <div class="form-group">
            <label>New Password</label>
            <input type="password" id="reset-new-password" placeholder="At least 8 characters" required minlength="8" />
          </div>
          <button type="submit" class="auth-button">Set New Password</button>
        </form>
      </div>
    </div>

    <div id="progress-modal" class="modal hidden">
      <div class="progress-card">
        <h3 id="progress-title">Generating ZIP...</h3>
        <div class="progress-track">
          <div id="progress-fill" class="progress-fill"></div>
        </div>
        <p id="progress-status">0%</p>
        <button id="progress-cancel" class="button" style="margin-top: 1.5rem; background: #ff4d4d; color: white;">Cancel</button>
      </div>
    </div>

    <div id="toast-container"></div>
  `;
  document.body.insertAdjacentHTML('beforeend', modalHTML);
}

window.initiatePasswordReset = function() {
  document.getElementById('email-prompt-modal').classList.remove('hidden');
  document.getElementById('reset-email-prompt').focus();
};

window.closeEmailPromptModal = function() {
  document.getElementById('email-prompt-modal').classList.add('hidden');
  document.getElementById('email-prompt-form').reset();
};

window.closeResetPasswordModal = function() {
  document.getElementById('reset-password-modal').classList.add('hidden');
  document.getElementById('password-reset-form').reset();
};

window.viewUserProfile = function(username) {
  if (!username || username === 'User') return;
  if (window.location.pathname.endsWith('index.html') || window.location.pathname.endsWith('/') || window.location.pathname.endsWith('BeyondFrame/')) {
    if (window.filterByUploader) {
      window.filterByUploader(username);
      closeModal();
      closeCommentModal();
    }
  } else {
    window.location.href = `index.html?user=${encodeURIComponent(username)}`;
  }
};

window.sendResetCodeEmail = async function(e) {
  e.preventDefault();
  const email = document.getElementById('reset-email-prompt').value.trim();
  if (!email) return;
  window.resetEmail = email;
  const success = await window.apiSendResetCode(email);
  if (success) {
    closeEmailPromptModal();
    const modal = document.getElementById('reset-password-modal');
    if (modal) {
      document.getElementById('reset-email').value = window.resetEmail;
      modal.classList.remove('hidden');
      document.getElementById('reset-code').focus();
    }
  }
};

window.resetPassword = async function(e) {
  e.preventDefault();
  const code = document.getElementById('reset-code').value;
  const newPassword = document.getElementById('reset-new-password').value;
  const success = await window.apiResetPassword(window.resetEmail, code, newPassword);
  if (success) {
    closeResetPasswordModal();
    if (window.logout) window.logout(true);
  }
};

window.closeDeleteAccountModal = function() {
  document.getElementById('delete-account-modal').classList.add('hidden');
  document.getElementById('delete-confirm-password').value = '';
};

// Modal logic: Shows the "pop-up" when an image is clicked
let currentModalImages = [];
let currentModalIndex = 0;
let currentModalTitle = '';
let currentModalDesc = '';
let currentModalMeta = '';
let currentModalAuthor = '';
window.activeSavePostId = null;
window.activeCommentPostId = null;

window.currentViewingPostId = null;
let currentCollectionPostIds = null;
async function openModal(images, index, title, description, meta, postId, author, collectionPostIds = null) {
  // Support both multi-image albums and single legacy calls
  // Ensure images is always an array
  const imgArray = Array.isArray(images) ? images : [images];
  if (imgArray.length > 0) {
    currentModalImages = imgArray;
    currentModalIndex = index;
    currentModalTitle = title;
    currentModalDesc = description;
    currentModalMeta = meta;
    window.currentViewingPostId = postId;
    currentModalAuthor = author;
    currentCollectionPostIds = collectionPostIds;
  } else {
    // images=src, index=title, title=desc, description=meta (Legacy signature)
    currentModalImages = [images];
    currentModalIndex = 0;
    currentModalTitle = index;
    currentModalDesc = title;
    currentModalMeta = description;
    window.currentViewingPostId = null;
    currentModalAuthor = '';
    currentCollectionPostIds = null;
  }

  await updateModalUI();
  document.getElementById('modal').classList.remove('hidden');
  document.body.style.overflow = 'hidden'; // Prevent background scroll
}

async function updateModalUI() {
  const data = currentModalImages[currentModalIndex];
  const src = window.resolveImgUrl(data);
  
  const img = document.getElementById('modal-image');
  img.src = src;
  img.onclick = toggleFullscreenView;

  document.getElementById('modal-title').textContent = currentModalTitle;
  document.getElementById('modal-description').textContent = currentModalDesc;
  document.getElementById('modal-meta').textContent = currentModalMeta;
  document.getElementById('modal-download').href = src;
  
  const prevBtn = document.getElementById('modal-prev');
  const nextBtn = document.getElementById('modal-next');
  const counter = document.getElementById('modal-counter');
  
  if (prevBtn && nextBtn && counter) {
    const isAlbum = currentModalImages.length > 1;
    prevBtn.classList.toggle('hidden', !isAlbum);
    nextBtn.classList.toggle('hidden', !isAlbum);
    counter.classList.toggle('hidden', !isAlbum);
    if (isAlbum) counter.textContent = `${currentModalIndex + 1} / ${currentModalImages.length}`;
  }

  // Visibility logic for uploader-only actions
  const modalDeleteBtn = document.getElementById('modal-delete-btn');
  const modalEditBtn = document.getElementById('modal-edit-btn');
  const token = localStorage.getItem('bf_token');
  const userPayload = token ? parseJwt(token) : null;
  const isModOrAdmin = userPayload && (userPayload.role === 'admin' || userPayload.role === 'moderator');
  const isOwner = getCurrentUser() === currentModalAuthor;

  if (modalDeleteBtn) modalDeleteBtn.style.display = (isOwner || isModOrAdmin) ? 'block' : 'none';
  if (modalEditBtn) modalEditBtn.style.display = isOwner ? 'block' : 'none';

  // Modal actions (Like, Comment, Save)
  const likeBtn = document.getElementById('modal-like');
  const saveBtn = document.getElementById('modal-save');
  const commentsList = document.getElementById('modal-comments-list');

  if (window.currentViewingPostId && likeBtn && saveBtn) {
    const posts = await getAllPosts();
    const post = posts.find(p => p.id === window.currentViewingPostId);
    if (post) {
      const collections = await getAllCollections();
      const isSaved = collections.some(c => c.postIds.includes(post.id));

      const heartIconSVG = `
        <svg class="heart-icon" viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
          <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l8.78-8.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path>
        </svg>`;
      
      likeBtn.innerHTML = `${heartIconSVG} ${post.likes || 0}`;
      likeBtn.classList.toggle('liked', !!post.userLiked);
      likeBtn.onclick = async () => {
        if (window.toggleLike) {
          await window.toggleLike(post.id);
          // After toggling, we re-fetch the post data to update the modal count
          updateModalUI();
        }
      };

      saveBtn.classList.toggle('saved', isSaved);
      saveBtn.onclick = () => {
        if (window.openSaveModal) window.openSaveModal(post.id);
      };

      // Render up to 3 most recent comments
      if (commentsList) {
        const recent = (post.reviews || []).slice(-3).reverse();
        const token = localStorage.getItem('bf_token');
        const userPayload = token ? parseJwt(token) : null;
        const isAdmin = userPayload && (userPayload.role === 'admin' || userPayload.role === 'moderator');
        const currentUsername = getCurrentUser();

        commentsList.innerHTML = recent.length 
          ? recent.map(r => {
              const name = (typeof r === 'string' ? 'User' : r.authorName) || 'User';
              const text = typeof r === 'string' ? r : r.text;
              const rId = (typeof r === 'object' && r !== null) ? r.id : null;

              const isPostOwner = currentUsername === post.author;
              const isCommentOwner = currentUsername === name;
              const canDelete = rId && (isAdmin || isPostOwner || isCommentOwner);

              return `
                <div class="modal-comment-item">
                  <div style="font-weight: 700; font-size: 0.85rem; margin-bottom: 0.2rem; color: var(--accent-color);">
                    <span class="uploader-link" onclick="viewUserProfile('${escapeHTML(name)}')">${escapeHTML(name)}</span>
                  </div>
                  <div style="opacity: 0.9; line-height: 1.4; margin-bottom: 0.4rem;">${escapeHTML(text)}</div>
                  <div class="comment-actions" style="margin-top: 0; opacity: 0.7;">
                    <span class="comment-action-link" style="font-size: 0.75rem;" onclick="openCommentModal('${window.currentViewingPostId}')">Reply</span>
                    ${canDelete ? `<span class="comment-action-link delete" style="font-size: 0.75rem;" onclick="deleteReview('${post.id}', '${rId}')">Delete</span>` : ''}
                  </div>
                </div>`;
            }).join('')
          : '<p style="opacity:0.4; font-size:0.85rem; font-style:italic;">No reviews yet.</p>';
      }
    }

    // Sync big screen if open
    updateBigScreenImage();
  }
}

window.openSaveModal = async function(postId) {
  window.activeSavePostId = postId;
  const collections = await getAllCollections();
  const list = document.getElementById('collection-list');
  if (!list) return;
  list.innerHTML = collections.length ? '' : '<p style="opacity:0.6;">No groups yet.</p>';
  
  collections.forEach(col => {
    const btn = document.createElement('button');
    btn.className = 'button';
    btn.style.width = '100%';
    btn.style.marginBottom = '0.5rem';
    btn.textContent = `+ ${col.name}`;
    btn.onclick = () => saveToGroup(col.name);
    list.appendChild(btn);
  });
  document.getElementById('save-modal').classList.remove('hidden');
};

window.closeSaveModal = function() {
  const modal = document.getElementById('save-modal');
  if (modal) modal.classList.add('hidden');
  window.activeSavePostId = null;
};

window.saveToGroup = async function(groupName, postId = null) {
  const targetPostId = postId || window.activeSavePostId;
  const collections = await getAllCollections();
  let group = collections.find(c => c.name === groupName);
  if (!group) group = { name: groupName, postIds: [] };

  const postIdIndex = group.postIds.indexOf(targetPostId);
  if (postIdIndex === -1) {
    group.postIds.push(targetPostId);
    await updateCollection(group);
    showToast(`Saved to ${groupName}`, 'success');
  } else {
    group.postIds.splice(postIdIndex, 1);
    await updateCollection(group);
    showToast(`Removed from ${groupName}`, 'info');
  }
  window.closeSaveModal();
  refreshUIGrids();
  if (window.currentViewingPostId === targetPostId) updateModalUI();
};

window.createNewGroupAndSave = async function() {
  const input = document.getElementById('new-group-name');
  if (!input) return;
  const name = input.value.trim();
  if (!name) return;
  await saveToGroup(name);
  input.value = '';
};

window.openCommentModal = async function(postId) {
  window.currentViewingPostId = postId;
  const posts = await getAllPosts();
  const post = posts.find(p => p.id === postId);
  const container = document.getElementById('modal-comments-container');
  if (!container) return;
  container.innerHTML = '';
  
  if (post && post.reviews && post.reviews.length > 0) {
    const token = localStorage.getItem('bf_token');
    const userPayload = token ? parseJwt(token) : null;
    const currentUsername = getCurrentUser();
    const isAdmin = userPayload && (userPayload.role === 'admin' || userPayload.role === 'moderator');

    post.reviews.forEach(r => {
      // Ensure every review is treated as an object with an authorName
      let reviewObj;
      if (typeof r === 'string') {
        reviewObj = { id: Date.now() + Math.random(), text: r, authorName: 'User', replies: [] };
      } else {
        reviewObj = { ...r, authorName: r.authorName || 'User' };
      }

      const isPostOwner = getCurrentUser() === post.author;
      const isCommentOwner = currentUsername === reviewObj.authorName;
      const canDelete = typeof r !== 'string' && (isAdmin || isPostOwner || isCommentOwner);

      const div = document.createElement('div');
      div.className = 'comment-bubble';
      div.innerHTML = `
        <div style="font-weight: 700; font-size: 0.9rem; margin-bottom: 0.3rem; color: var(--accent-color);">
          <span class="uploader-link" onclick="viewUserProfile('${escapeHTML(reviewObj.authorName || 'User')}')">
            ${escapeHTML(reviewObj.authorName || 'User')}
          </span>
        </div>
        <div style="line-height: 1.5; margin-bottom: 0.5rem;">${escapeHTML(reviewObj.text)}</div>
        <div class="comment-actions">
          <span class="comment-action-link" onclick="showReplyInput('${reviewObj.id}')">Reply</span>
          ${canDelete ? `<span class="comment-action-link delete" onclick="deleteReview('${postId}', '${reviewObj.id}')">Delete</span>` : ''}
        </div>
        <div id="reply-input-${reviewObj.id}" class="comment-input-area hidden" style="margin-top:0.5rem;">
          <input type="text" id="input-field-${reviewObj.id}" placeholder="Write a reply..." onkeydown="if(event.key === 'Enter') submitReply('${postId}', '${reviewObj.id}')" />
          <button class="button" style="padding:0.2rem 0.5rem; font-size:0.75rem;" onclick="submitReply('${postId}', '${reviewObj.id}')">Reply</button>
        </div>
        <div class="replies-list">
          ${(() => {
            const allReps = reviewObj.replies || [];
            const renderRep = (rep) => {
          const rName = rep.authorName || 'User';
          const isReplyOwner = currentUsername === rName;
          const canDeleteReply = typeof rep !== 'string' && (isAdmin || isPostOwner || isReplyOwner);
          return `
          <div class="reply-bubble" style="margin-top: 0.75rem; border-left: 2px solid var(--border-color); padding-left: 0.75rem;">
            <div style="font-weight: 700; font-size: 0.75rem; margin-bottom: 0.2rem; color: var(--accent-color);">
              <span class="uploader-link" onclick="viewUserProfile('${escapeHTML(rName)}')">${escapeHTML(rName)}</span>
            </div>
            <div style="opacity: 0.85; font-size: 0.85rem; margin-bottom: 0.25rem;">${escapeHTML(rep.text)}</div>
            <div class="comment-actions">
              <span class="comment-action-link" style="font-size: 0.7rem;" onclick="replyToUser('${reviewObj.id}', '${escapeHTML(rName)}')">Reply</span>
              ${canDeleteReply ? `<span class="comment-action-link delete" style="font-size: 0.7rem;" onclick="deleteReview('${postId}', '${rep.id}')">Delete</span>` : ''}
            </div>
          </div>`;
            };

            const visible = allReps.slice(0, 1).map(renderRep).join('');
            const hidden = allReps.slice(1).map(renderRep).join('');
            
            return visible + (hidden ? `
              <div id="more-replies-${reviewObj.id}" class="hidden">${hidden}</div>
              <div style="margin-top: 0.5rem;">
                <span class="comment-action-link" id="toggle-btn-${reviewObj.id}" style="font-size: 0.75rem;" onclick="toggleRepliesVisibility('${reviewObj.id}')">
                  Show ${allReps.length - 1} more replies
                </span>
              </div>` : '');
          })()}
        </div>
      `;
      container.appendChild(div);
    });
  } else {
    container.innerHTML = '<p style="opacity:0.6; font-style:italic;">No reviews yet.</p>';
  }
  document.getElementById('comment-modal').classList.remove('hidden');
};

window.closeCommentModal = function() {
  const modal = document.getElementById('comment-modal');
  if (modal) modal.classList.add('hidden');
  window.currentViewingPostId = null;
};

// Unified Rendering Helper for Comments & Replies
/**
 * @param {Object|string} r - The review object or string
 * @param {string} postId - Unique ID of the post
 * @param {boolean} isAdmin - Admin status of current user
 * @param {boolean} isPostOwner - If current user owns the post
 * @param {string} currentUsername - Logged in username
 * @param {string} postAuthor - Original uploader's name
 * @param {boolean} [isBulk=false] - If rendering in the bulk review modal
 * @returns {string} HTML string
 */
window.renderCommentThreadHTML = function(r, postId, isAdmin, isPostOwner, currentUsername, postAuthor, isBulk = false) {
  const prefix = isBulk ? 'bulk-' : '';
  const name = (typeof r === 'string' ? 'User' : r.authorName) || 'User';
  const text = typeof r === 'string' ? r : r.text;
  let reviewObj;
  if (typeof r === 'string') {
    reviewObj = { id: Date.now() + Math.random(), text: r, authorName: 'User', replies: [] };
  } else {
    reviewObj = { ...r, authorName: r.authorName || 'User' };
  }

  const rId = reviewObj.id;
  const isCommentOwner = currentUsername === name;
  const canDelete = rId && (isAdmin || isPostOwner || isCommentOwner);

  // Sub-helper for rendering replies
  const renderReplyBubble = (rep) => {
    const rName = (rep.authorName || 'User');
    const isReplyOwner = currentUsername === rName;
    const canDeleteReply = typeof rep !== 'string' && (isAdmin || isPostOwner || isReplyOwner);
    return `
      <div class="reply-bubble" style="margin-top: 0.75rem; border-left: 2px solid var(--border-color); padding-left: 0.75rem; padding-bottom: 0.5rem; background: rgba(255,255,255,0.02); border-radius: 0.5rem;">
        <div style="font-weight: 700; font-size: 0.8rem; margin-bottom: 0.2rem; color: var(--accent-color);">
          <span class="uploader-link" onclick="viewUserProfile('${escapeHTML(rName)}')">${escapeHTML(rName)}</span>
          ${rName === postAuthor ? '<span class="creator-badge">Creator</span>' : ''}
          <span style="font-size: 0.7rem; opacity: 0.4; margin-left: 0.4rem; font-weight: 400;">${window.getRelativeTime(rep.id)}</span>
        </div>
        <div style="opacity: 0.85; font-size: 0.85rem; margin-bottom: 0.3rem; line-height:1.4;">${escapeHTML(rep.text)}</div>
        <div class="comment-actions">
          <span class="comment-action-link" style="font-size: 0.7rem;" onclick="replyToUser('${rId}', '${escapeHTML(rName)}', ${isBulk})">Reply</span>
          ${canDeleteReply ? `<span class="comment-action-link delete" style="font-size: 0.7rem;" onclick="deleteReview('${postId}', '${rep.id}')">Delete</span>` : ''}
        </div>
      </div>`;
  };

  const allReps = [...(reviewObj.replies || [])].reverse();
  const visibleReps = allReps.slice(0, 1).map(renderReplyBubble).join('');
  const hiddenReps = allReps.slice(1).map(renderReplyBubble).join('');

  return `
    <div class="modal-comment-item comment-bubble" style="text-align: left; padding: 1.25rem; margin-bottom: 1.5rem; border: 1px solid var(--border-color); background: rgba(255,255,255,0.03);">
      <div style="font-weight: 700; font-size: 0.9rem; margin-bottom: 0.3rem; color: var(--accent-color);">
        <span class="uploader-link" onclick="viewUserProfile('${escapeHTML(name)}')">${escapeHTML(name)}</span>
        ${name === postAuthor ? '<span class="creator-badge">Creator</span>' : ''}
        <span style="font-size: 0.75rem; opacity: 0.4; margin-left: 0.4rem; font-weight: 400;">${window.getRelativeTime(reviewObj.id)}</span>
      </div>
      <div style="opacity: 0.9; line-height: 1.5; margin-bottom: 0.5rem;">${escapeHTML(text)}</div>
      <div class="comment-actions" style="margin-top: 0; opacity: 0.8;">
        <span class="comment-action-link" style="font-size: 0.75rem;" onclick="showReplyInput('${rId}', ${isBulk})">Reply</span>
        ${canDelete ? `<span class="comment-action-link delete" style="font-size: 0.75rem;" onclick="deleteReview('${postId}', '${rId}')">Delete</span>` : ''}
      </div>
      <div id="${prefix}reply-input-${rId}" class="comment-input-area hidden" style="margin-top:0.75rem;">
        <input type="text" id="${prefix}input-field-${rId}" placeholder="Write a reply..." onkeydown="if(event.key === 'Enter') submitReply('${postId}', '${rId}', ${isBulk})" style="font-size:0.85rem; padding: 0.5rem;"/>
        <button class="button" style="padding:0.4rem 0.8rem; font-size:0.75rem;" onclick="submitReply('${postId}', '${rId}', ${isBulk})">Post</button>
      </div>
      <div class="replies-list" style="margin-top: 0.5rem;">
        ${visibleReps}
        ${hiddenReps ? `
          <div id="${prefix}more-replies-${rId}" class="hidden">${hiddenReps}</div>
          <div style="margin-top: 0.5rem;">
            <span class="comment-action-link" id="${prefix}toggle-btn-${rId}" style="font-size: 0.75rem;" 
                  onclick="toggleRepliesVisibility('${rId}', ${isBulk})">
              Show ${allReps.length - 1} more replies
            </span>
          </div>` : ''}
      </div>
    </div>`;
};

window.toggleModalCommentsVisibility = function() {
  const container = document.getElementById('modal-more-comments');
  const btn = document.getElementById('modal-comments-toggle-btn');
  if (container && btn) {
    const isHidden = container.classList.toggle('hidden');
    btn.textContent = isHidden ? `Show older reviews` : 'Hide reviews';
  }
};

window.toggleBulkCommentsVisibility = function() {
  const container = document.getElementById('bulk-more-comments');
  const btn = document.getElementById('bulk-comments-toggle-btn');
  if (container && btn) {
    const isHidden = container.classList.toggle('hidden');
    btn.textContent = isHidden ? `Show older reviews` : 'Hide reviews';
  }
};

window.toggleRepliesVisibility = function(reviewId, isBulk = false) {
  const prefix = isBulk ? 'bulk-' : '';
  const container = document.getElementById(`${prefix}more-replies-${reviewId}`);
  const btn = document.getElementById(`${prefix}toggle-btn-${reviewId}`);
  if (container && btn) {
    const isHidden = container.classList.toggle('hidden');
    btn.textContent = isHidden ? `Show more replies` : 'Hide replies';
  }
};

window.replyToUser = function(reviewId, username, isBulk = false) {
  const prefix = isBulk ? 'bulk-' : '';
  const el = document.getElementById(`${prefix}reply-input-${reviewId}`);
  if (el) {
    el.classList.remove('hidden');
    const input = document.getElementById(`${prefix}input-field-${reviewId}`);
    if (input) {
      input.value = `@${username} `;
      input.focus();
    }
  }
};

window.showReplyInput = function(reviewId, isBulk = false) {
  const prefix = isBulk ? 'bulk-' : '';
  const el = document.getElementById(`${prefix}reply-input-${reviewId}`);
  if (el) {
    el.classList.toggle('hidden');
    if (!el.classList.contains('hidden')) {
      const input = document.getElementById(`${prefix}input-field-${reviewId}`);
      if (input) input.focus();
    }
  }
};

window.deleteReview = async function(postId, reviewId) {
  if (!confirm('Delete this?')) return;
  const posts = await getAllPosts();
  const post = posts.find(p => p.id === postId);
  if (!post || !post.reviews) return;

  let found = false;
  // Filter top-level reviews
  const initialLength = post.reviews.length;
  post.reviews = post.reviews.filter(r => {
    if ((r.id || '').toString() === reviewId.toString()) {
      found = true;
      return false;
    }
    // Filter nested replies
    if (r.replies) {
      const rLen = r.replies.length;
      r.replies = r.replies.filter(rep => (rep.id || '').toString() !== reviewId.toString());
      if (r.replies.length < rLen) found = true;
    }
    return true;
  });

  if (found) {
    await addPost(post);
    showToast("Deleted.", "success");
    refreshUIGrids();
    updateModalUI();
    const commentModal = document.getElementById('comment-modal');
    if (commentModal && !commentModal.classList.contains('hidden')) {
      window.openCommentModal(postId);
    }
  }
};

window.submitComment = async function(postId, inputId) {
  const input = document.getElementById(inputId);
  if (!input) return;
  const text = input.value.trim();
  const targetPostId = postId || window.currentViewingPostId;
  if (!text || !targetPostId) return;

  const token = localStorage.getItem('bf_token');
  const userPayload = token ? parseJwt(token) : null;
  const currentUsername = (userPayload && userPayload.username) || localStorage.getItem('bf_username') || 'User';

  const posts = await getAllPosts();
  const post = posts.find(p => p.id === targetPostId);
  if (post) {
    if (!post.reviews) post.reviews = [];
    post.reviews.push({ 
      id: Date.now(), 
      text: text, 
      authorId: userPayload ? userPayload.user_id : null, 
      authorName: currentUsername, 
      replies: [] 
    });
    await addPost(post);
    input.value = '';
    
    // Refresh whichever view is currently active
    const commentModal = document.getElementById('comment-modal');
    if (commentModal && !commentModal.classList.contains('hidden')) {
      window.openCommentModal(targetPostId);
    } else {
      await updateModalUI();
    }
    refreshUIGrids();
  }
};

window.submitReviewFromModal = () => window.submitComment(window.currentViewingPostId, 'modal-comment-input-bulk');

window.submitReply = async function(postId, reviewId, isBulk = false) {
  const prefix = isBulk ? 'bulk-' : '';
  const input = document.getElementById(`${prefix}input-field-${reviewId}`);
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  const token = localStorage.getItem('bf_token'); // Re-fetch token for freshness
  const userPayload = token ? parseJwt(token) : null; // Re-parse payload
  const currentUsername = (userPayload && userPayload.username) || localStorage.getItem('bf_username') || 'User';
  const posts = await getAllPosts();
  const post = posts.find(p => p.id === postId);
  if (post && post.reviews) {
    const review = post.reviews.find(r => (r.id || '').toString() === reviewId.toString());
    if (!review.replies) review.replies = [];
    review.replies.push({ id: Date.now(), text: text, authorId: userPayload ? userPayload.user_id : null, authorName: currentUsername });
    await addPost(post);
    input.value = '';
    
    // Fully refresh both views to ensure consistency
    await updateModalUI(); 
    const modal = document.getElementById('comment-modal');
    if (modal && !modal.classList.contains('hidden')) {
      await window.openCommentModal(postId);
    }
    refreshUIGrids();
  }
};

window.toggleLike = async function(postId) {
  if (!localStorage.getItem('bf_token')) {
    showToast('Please log in to like posts', 'info');
    setTimeout(() => window.location.href = 'auth.html', 1500);
    return;
  }

  try {
    const response = await fetch(`${API_URL}/posts/toggle-like`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ postId })
    });
    
    if (response.status === 401) {
      showToast('Session expired. Please log in again.', 'error');
      setTimeout(() => window.logout(true), 2000);
      return;
    }

    if (response.ok) {
      const data = await response.json();
      console.log(`Like status: ${data.status} for post ${postId}`);
      refreshUIGrids();
    } else {
      const data = await response.json().catch(() => ({ error: 'Unknown server error' }));
      showToast(data.error || 'Failed to toggle like', 'error');
    }
  } catch (err) {
    console.error("Like Error:", err);
    showToast('Network error while liking.', 'error');
  }
};

async function loadAdminStats() {
  const token = localStorage.getItem('bf_token');
  if (!token) return;
  const payload = parseJwt(token);
  // Only proceed if user is admin and on the admin page
  if (!payload || payload.role !== 'admin' || !window.location.pathname.includes('admin.html')) return;

  try {
    const res = await fetch(`${API_URL}/admin/stats`, { headers: getAuthHeaders() });
    if (res.ok) {
      const data = await res.json();
      let container = document.getElementById('admin-stats-display');
      
      if (!container) {
        container = document.createElement('div');
        container.id = 'admin-stats-display';
        container.className = 'gallery-section'; 
        const header = document.querySelector('.site-header');
        if (header) header.insertAdjacentElement('afterend', container);
        else document.body.prepend(container);
      }
      
      container.innerHTML = `
        <div class="admin-dashboard-stats">
          <div class="stat-item">
            <span class="stat-label">Total Registered</span>
            <span class="stat-value">${data.totalUsers || 0}</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">Unblocked</span>
            <span class="stat-value" style="color: #40c057;">${data.activeUsers || 0}</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">Blocked</span>
            <span class="stat-value" style="color: #ff4d4d;">${data.blockedUsers || 0}</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">Active</span>
            <span class="stat-value">${data.onlineUsers || 0}</span>
          </div>
        </div>
      `;
    }
  } catch (e) { console.error("Stats load failed", e); }
}

// Notification Logic
let lastUnreadCount = -1;
async function fetchNotificationsCount() {
  const res = await fetch(`${API_URL}/notifications`, { headers: getAuthHeaders() });
  if (res.ok) {
    const notes = await res.json();
    const unread = notes.filter(n => !n.isRead).length;

    // Play sound if count increased and it's not the first check of this session
    if (lastUnreadCount !== -1 && unread > lastUnreadCount) {
      playNotificationSound();
    }
    lastUnreadCount = unread;

    const badge = document.getElementById('nav-note-badge');
    if (badge) {
      badge.textContent = unread;
      badge.classList.toggle('hidden', unread === 0);
    }
  }
}

window.openNotificationsModal = async function() {
  document.getElementById('notifications-modal').classList.remove('hidden');
  const list = document.getElementById('notifications-list');
  const res = await fetch(`${API_URL}/notifications`, { headers: getAuthHeaders() });
  if (res.ok) {
    const notes = await res.json();
    if (notes.length === 0) {
      list.innerHTML = '<p style="opacity:0.6;">No notifications yet.</p>';
    } else {
      list.innerHTML = notes.map(n => {
        let msg = '';
        if (n.type === 'like') msg = `liked your post "<b>${n.postTitle}</b>"`;
        if (n.type === 'comment') msg = `commented on your post "<b>${n.postTitle}</b>"`;
        if (n.type === 'reply') msg = `replied to your review on "<b>${n.postTitle}</b>"`;
        
        return `
          <div onclick="navigateToPostFromNote('${n.postId}', '${n.type}')" style="cursor: pointer; padding: 0.75rem; border-bottom: 1px solid var(--border-color); font-size: 0.9rem; ${n.isRead ? 'opacity: 0.6;' : 'background: rgba(77,171,247,0.05); border-left: 3px solid var(--accent-color);'}">
            <b>${n.actorName}</b> ${msg}
            <div style="font-size: 0.75rem; opacity: 0.5; margin-top: 0.25rem;">${new Date(n.createdAt).toLocaleString()}</div>
          </div>
        `;
      }).join('');
    }
  }
};

window.closeNotificationsModal = function() {
  document.getElementById('notifications-modal').classList.add('hidden');
};

window.navigateToPostFromNote = async function(postId, type) {
  closeNotificationsModal();
  await switchToPost(postId);
  // If it's a comment or reply notification, automatically open the reviews/comment modal
  if (type === 'comment' || type === 'reply') {
    openCommentModal(postId);
  }
};

window.markAllNotesRead = async function() {
  const res = await fetch(`${API_URL}/notifications/read`, {
    method: 'POST',
    headers: getAuthHeaders()
  });
  if (res.ok) {
    fetchNotificationsCount();
    const list = document.getElementById('notifications-list');
    // Visually dim them immediately
    const items = list.querySelectorAll('div');
    items.forEach(i => {
      i.style.opacity = '0.6';
      i.style.borderLeft = 'none';
    });
  }
};

window.switchToPost = async function(postId) {
  const posts = await getAllPosts();
  const post = posts.find(p => p.id === postId);
  if (!post) {
    showToast("This post is no longer available.", "info");
    return;
  }

  const images = Array.isArray(post.imageData) ? post.imageData : [post.imageData];

  currentModalImages = images;
  currentModalIndex = 0;
  currentModalTitle = post.title;
  currentModalDesc = post.description;
  currentModalMeta = `Posted by ${post.author}`;
  window.currentViewingPostId = post.id;
  currentModalAuthor = post.author;

  updateModalUI();
  document.getElementById('modal').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function refreshUIGrids() {
  if (window.renderHomePreview) {
    if (window.cachedPosts) window.cachedPosts = []; 
    window.renderHomePreview(window.currentAuthorFilter);
  }
  if (window.renderCollections) {
    window.renderCollections();
  }
  if (window.renderPosts) {
    getAllPosts().then(posts => {
      window.allPostsCache = posts;
      window.renderPosts(posts);
    });
  }
  if (window.loadProfile) {
    window.loadProfile();
  }
}

function toggleFullscreenView() {
  const modal = document.getElementById('modal');
  if (!modal) return;

  const content = modal.querySelector('.modal-content');

  if (!content.classList.contains('fullscreen-view')) {
    // Enter Fullscreen mode
    content.classList.add('fullscreen-view');
  } else {
    // Open "Big Screen" overlay overlapping the current fullscreen modal
    openBigScreen();
  }
}

function openBigScreen() {
  const bigOverlay = document.getElementById('big-screen-overlay');
  const bigImg = document.getElementById('big-screen-image');
  const modalImg = document.getElementById('modal-image');
  
  if (bigOverlay && bigImg && modalImg) {
    bigImg.src = modalImg.src;
    bigOverlay.classList.remove('hidden');
    updateBigScreenImage();

    // Attach zoom and pan handlers for Big Screen
    const container = bigOverlay.querySelector('.modal-image-container');
    bigImg.ondblclick = handleBigScreenZoom;
    container.onmousemove = handleBigScreenPan;
  }
}

function closeBigScreen() {
  const bigOverlay = document.getElementById('big-screen-overlay');
  if (bigOverlay) {
    bigOverlay.classList.add('hidden');
    resetBigScreenZoom();
  }
}

function updateBigScreenImage() {
  const bigImg = document.getElementById('big-screen-image');
  const modalImg = document.getElementById('modal-image');
  const modalCounter = document.getElementById('modal-counter');
  const bigOverlay = document.getElementById('big-screen-overlay');
  const bigCounter = bigOverlay ? bigOverlay.querySelector('.image-counter') : null;

  if (bigImg && modalImg) {
    if (bigImg.src !== modalImg.src) {
      bigImg.src = modalImg.src;
      resetBigScreenZoom(); // Reset zoom state when image changes
    }
  }
  if (bigCounter && modalCounter) {
    bigCounter.textContent = modalCounter.textContent;
    bigCounter.classList.toggle('hidden', modalCounter.classList.contains('hidden'));
  }
}

function handleBigScreenZoom(e) {
  const container = document.querySelector('#big-screen-overlay .modal-image-container');
  const img = document.getElementById('big-screen-image');
  if (!container || !img) return;

  const isZoomed = container.classList.toggle('zoomed');
  if (isZoomed) {
    handleBigScreenPan(e); // Calculate initial pan based on click position
  } else {
    img.style.transformOrigin = 'center center';
  }
}

function handleBigScreenPan(e) {
  const container = document.querySelector('#big-screen-overlay .modal-image-container');
  if (!container || !container.classList.contains('zoomed')) return;

  const img = document.getElementById('big-screen-image');
  const rect = container.getBoundingClientRect();
  const x = ((e.clientX - rect.left) / rect.width) * 100;
  const y = ((e.clientY - rect.top) / rect.height) * 100;

  img.style.transformOrigin = `${x}% ${y}%`;
}

function resetBigScreenZoom() {
  const container = document.querySelector('#big-screen-overlay .modal-image-container');
  const img = document.getElementById('big-screen-image');
  if (container) container.classList.remove('zoomed');
  if (img) {
    img.style.transformOrigin = 'center center';
  }
}

function toggleModalMenu(e) {
  e.stopPropagation();
  const dropdown = document.getElementById('modal-menu-dropdown');
  if (dropdown) dropdown.style.display = dropdown.style.display === 'flex' ? 'none' : 'flex';
}

window.submitCommentFromModal = () => window.submitComment(window.currentViewingPostId, 'modal-comment-input'); // Use currentViewingPostId

async function sharePostFromModal() {
  if (window.sharePost) window.sharePost(window.currentViewingPostId, currentModalIndex);
}

async function deletePostFromModal() {
  if (window.deletePostUI) {
    await window.deletePostUI(window.currentViewingPostId);
    closeModal();
  }
}

window.deletePostUI = async function(id) {
  if(confirm('Delete this album?')) {
    try {
      await deletePost(id);
      refreshUIGrids();
    } catch (err) {
      showToast('Failed to delete: ' + err.message, 'error');
    }
  }
};

window.sharePost = function(id, index = 0) {
  // Use the established API_URL to construct the direct image link
  const directImageUrl = `${API_URL}/posts/image/${id}/${index}`;

  navigator.clipboard.writeText(directImageUrl).then(() => {
    showToast('Direct image link copied!', 'success');
  }).catch(err => {
    console.error('Failed to copy:', err);
    showToast('Failed to copy link to clipboard', 'error');
  });
};

window.editPost = function(id) {
  window.location.href = `submit.html?edit=${id}`;
};

function editPostFromModal() {
  if (window.editPost) window.editPost(window.currentViewingPostId); // Use currentViewingPostId
}

function calculateTotalComments(post) {
  if (!post || !post.reviews) return 0;
  return post.reviews.reduce((acc, r) => acc + 1 + (r.replies ? r.replies.length : 0), 0);
}

// Close modal dropdowns on outside click
window.addEventListener('click', () => {
  const dropdown = document.getElementById('modal-menu-dropdown');
  if (dropdown) dropdown.style.display = 'none';
});

async function modalNext() {
  if (currentModalImages.length > 1 && currentModalIndex < currentModalImages.length - 1) {
    currentModalIndex++;
    updateModalUI();
  } else if (currentCollectionPostIds) {
    const idx = currentCollectionPostIds.indexOf(currentModalPostId);
    if (idx !== -1) {
      const nextIdx = (idx + 1) % currentCollectionPostIds.length;
      await switchToPost(currentCollectionPostIds[nextIdx]);
    }
  } else if (currentModalImages.length > 1) {
    currentModalIndex = (currentModalIndex + 1) % currentModalImages.length;
    updateModalUI();
  }
}

async function modalPrev() {
  if (currentModalIndex > 0) {
    currentModalIndex--;
    updateModalUI();
  } else if (currentCollectionPostIds) {
    const idx = currentCollectionPostIds.indexOf(currentModalPostId);
    if (idx !== -1) {
      const prevIdx = (idx - 1 + currentCollectionPostIds.length) % currentCollectionPostIds.length;
      await switchToPost(currentCollectionPostIds[prevIdx]);
      currentModalIndex = currentModalImages.length - 1;
      updateModalUI();
    }
  } else if (currentModalImages.length > 1) {
    currentModalIndex = (currentModalIndex - 1 + currentModalImages.length) % currentModalImages.length;
    updateModalUI();
  }
}

// Hides the modal pop-up
function closeModal() {
  const modal = document.getElementById('modal');
  if (modal) {
    modal.classList.add('hidden');
    closeBigScreen();
    const content = modal.querySelector('.modal-content');
    if (content) content.classList.remove('fullscreen-view');
    document.body.style.overflow = ''; // Restore scroll
  }
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => { toast.classList.add('fade-out'); setTimeout(() => toast.remove(), 500); }, 3000);
}

window.showProgress = function(visible, title = "Processing...", percent = 0) {
  const modal = document.getElementById('progress-modal');
  const bar = document.getElementById('progress-fill');
  const status = document.getElementById('progress-status');
  const titleEl = document.getElementById('progress-title');
  if (!modal || !bar || !status || !titleEl) return;
  if (visible) {
    modal.classList.remove('hidden');
    titleEl.textContent = title;
    bar.style.width = percent + '%';
    status.textContent = Math.round(percent) + '%';
  } else {
    modal.classList.add('hidden');
  }
};