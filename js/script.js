// Immediate theme check to prevent flash
(function() {
  const savedTheme = localStorage.getItem('bf_theme') || 'system';
  const prefersLight = window.matchMedia('(prefers-color-scheme: light)').matches;

  if (savedTheme === 'light' || (savedTheme === 'system' && prefersLight)) {
    document.documentElement.classList.add('light-mode');
  }
})();

// Register Service Worker for PWA support
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('js/service-worker.js', { scope: '/' });
  });
}

// Global swipe utility
function addSwipeListeners(element, onSwipeLeft, onSwipeRight) {
  let touchStartX = 0;
  let touchEndX = 0;
  const SWIPE_THRESHOLD = 50; // pixels

  element.addEventListener('touchstart', (e) => {
    touchStartX = e.touches[0].clientX;
  }, { passive: true }); // Use passive listener for better scroll performance

  element.addEventListener('touchend', (e) => {
    touchEndX = e.changedTouches[0].clientX;
    const diff = touchStartX - touchEndX;

    if (Math.abs(diff) > SWIPE_THRESHOLD) {
      if (diff > 0) onSwipeLeft(); // Swiped left
      else onSwipeRight(); // Swiped right
    }
  }, { passive: true });
}

// Global variable to store config
let appConfig = {};
let API_URL = ''; // Declare as let, will be set after config is loaded

// Function to load configuration from the json folder
async function loadConfig() {
  const location = window.location;
  const origin = location.origin === 'null' ? '' : location.origin;
  const rootPath = location.pathname.replace(/\/[^/]*$/, '/') || '/';
  const rootUrl = `${origin}/`;
  const candidateUrls = [
    `${rootUrl}json/config.json`,
    `${origin}${rootPath}json/config.json`,
    `${origin}${rootPath}../json/config.json`,
    `json/config.json`
  ];

  for (const url of candidateUrls) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        continue;
      }
      const config = await response.json();
      console.log('Project Configuration Loaded:', config, 'from', url);
      appConfig = config;
      return config;
    } catch (error) {
      console.debug('Config request failed for', url, error);
    }
  }

  console.warn('config.json not found at any candidate URL, using default API_PORT 8000');
  appConfig = { API_PORT: 8000 };
  return appConfig;
}

// Base function to construct the API URL, using the loaded appConfig
const getApiUrlBase = () => {
  const protocol = window.location.protocol === 'file:' ? 'http:' : window.location.protocol;
  const hostname = window.location.hostname || 'localhost';
  const port = window.location.port;
  const apiPort = appConfig.API_PORT || 8000;
  const rootPath = window.location.pathname.replace(/\/[^/]*$/, '/') || '/';
  const base = rootPath.includes('/BeyondFrame/') ? '/BeyondFrame' : '';

  const isPrivateHost = hostname === 'localhost' ||
                        hostname === '127.0.0.1' ||
                        hostname === '0.0.0.0' ||
                        /^192\.168\./.test(hostname) ||
                        /^10\./.test(hostname) ||
                        /^172\.(1[6-9]|2[0-9]|3[01])\./.test(hostname) ||
                        hostname === '';

  if (isPrivateHost) {
    return `${protocol}//${hostname}:${apiPort}/api`;
  }

  if (port && port !== String(apiPort)) {
    return `${protocol}//${hostname}:${apiPort}/api`;
  }

  return `${protocol}//${hostname}${base}/api`;
};

// Function to dismiss the startup overlay (called by the Explore button)
window.startExplore = function(btn) {
  if (btn) btn.classList.add('loading');
  const overlay = document.querySelector('.startup-overlay');
  if (overlay) {
    overlay.classList.add('fade-out');
    // Completely remove from DOM after animation to free up mobile memory
    setTimeout(() => overlay.remove(), 1000);
  }
};

window.currentAuthorFilter = null;
window.cachedPosts = [];

let heartbeatInterval = null;
let postIdToDelete = null;

window.getAuthHeaders = function() {
  const token = localStorage.getItem('bf_token');
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  };

  // Bypass Ngrok interstitial warning page for background API requests
  if (window.location.hostname.includes('.ngrok-free.app') || window.location.hostname.includes('.locallinear.app')) {
    headers['ngrok-skip-browser-warning'] = 'true';
  }

  return headers;
};

let appInitialized = false;
// Initializes the UI and Theme (Legacy name kept for HTML compatibility)
async function initApp() { // Renamed for clarity, as it does more than just 'open database'
  if (appInitialized) return Promise.resolve();

  await loadConfig(); // Load config first
  API_URL = getApiUrlBase(); // Set API_URL after config is loaded
  console.info('BeyondFrame API_URL resolved to', API_URL);
  if (!API_URL) {
    console.error('BeyondFrame API_URL could not be resolved, using fallback.');
    const fallbackOrigin = window.location.origin === 'null' ? 'http://localhost:8000' : window.location.origin;
    API_URL = `${fallbackOrigin}/api`;
  }

  try {
    injectModals();
  } catch (e) {
    console.error("Critical: Modal injection failed", e);
  }
  
  initTheme();
  if (window.location.pathname.includes('admin.html')) loadAdminStats();

  // Start heartbeat to track "Active" status
  if (localStorage.getItem('bf_token')) {
    heartbeatInterval = setInterval(async () => {
      try {
        const res = await fetch(`${API_URL}/heartbeat`, { 
          method: 'POST', 
          headers: getAuthHeaders(),
          mode: 'cors'
        });
        
        // Handle Immediate Account Deletion (404), Block (403), or Expired Session (401)
        if (res.status === 401 || res.status === 404 || res.status === 403) {
          let reason = 'deleted';
          if (res.status === 403) reason = 'blocked';
          
          showKickoutModal(reason);
          return;
        }

        if (res.ok) {
          const data = await res.json();
          const payload = parseJwt(localStorage.getItem('bf_token'));
          if (!payload) return;

          // 1. Maintenance Restriction
          if (data.maintenance && payload.role !== 'admin') {
            showMaintenanceWall();
            return;
          }

          // 3. Role Change Detection (e.g., moderator removal)
          if (data.role !== payload.role) {
            showKickoutModal('role_change');
            return;
          }
        }
      } catch (e) {
        console.group("BeyondFrame Connection Error");
        console.error("Heartbeat failed. Target URL:", API_URL);
        console.error("Error Detail:", e);
        console.warn("Check if Python server is active on port", (appConfig.API_PORT || 8000));
        console.groupEnd();

        if (window.location.protocol === 'https:' && API_URL.startsWith('http:')) {
          console.error("CRITICAL: Mixed Content. You are accessing the site via HTTPS but the API is HTTP. Browsers block this.");
        }

        console.warn("Heartbeat failed, check server console for CORS or Connectivity errors.");
      }
    }, 3000); // Increased frequency to 3 seconds for faster detection

    window.addEventListener('beforeunload', () => {
      if (!localStorage.getItem('bf_token')) return;
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
      }
      window.unloadMarkInactive();
    });
  }

  // Perform initial status checks after config is ready
  checkMaintenanceStatus(); 
  checkFeedbackStatus();

  // Start beach animations if light mode is active on startup
  if (document.querySelector('.startup-overlay')) {
    initBeachAnimations();
  }

  window.db = "SERVER_MODE"; // Signal to forms that the system is ready
  appInitialized = true;
  return Promise.resolve();
}

async function checkMaintenanceStatus() {
  try {
    const res = await fetch(`${API_URL}/settings/maintenance-status`);
    const data = await res.json();
    const payload = parseJwt(localStorage.getItem('bf_token'));
    
    if (data.enabled && (!payload || payload.role !== 'admin')) {
      showMaintenanceWall();
    }
  } catch (e) {
    console.error("Maintenance check failed", e);
  }
}

function showMaintenanceWall() {
  if (document.getElementById('maintenance-screen')) return;
  
  const screen = document.createElement('div');
  screen.id = 'maintenance-screen';
  screen.className = 'maintenance-screen';
  screen.innerHTML = `
    <div style="font-size: 5rem; margin-bottom: 1.5rem; filter: drop-shadow(0 0 20px rgba(77, 171, 247, 0.2));">🛠️</div>
    <h1>Under Maintenance</h1>
    <p style="opacity: 0.7; max-width: 500px; line-height: 1.6; margin-bottom: 2.5rem;">
      BeyondFrame is currently undergoing scheduled maintenance to improve your experience. 
      We'll be back online shortly!
    </p>
    <button class="button" onclick="window.location.reload()">Retry Connection</button>
  `;
  
  document.body.appendChild(screen);
  document.body.style.overflow = 'hidden';
  
  // Clear session to prevent any background API calls
  localStorage.removeItem('bf_token');
  localStorage.removeItem('bf_username');
  localStorage.removeItem('bf_role');
}

function showKickoutModal(reason, autoLogoutDelay = 3000) {
  const modal = document.getElementById('system-kickout-modal');
  // If modal is missing or already visible, don't re-trigger logic
  if (!modal || !modal.classList.contains('hidden')) return;
  
  // Stop the heartbeat immediately to prevent repeated triggers
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
  
  const title = document.getElementById('kickout-title');
  const msg = document.getElementById('kickout-message');
  const icon = document.getElementById('kickout-icon');
  
  if (reason === 'blocked') {
    title.textContent = 'Account Blocked';
    msg.textContent = 'Your account has been suspended for violating community guidelines. You will be logged out now.';
    icon.innerHTML = `
      <svg viewBox="0 0 24 24" width="60" height="60" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10"></circle>
        <line x1="4.93" y1="4.93" x2="19.07" y2="19.07"></line>
      </svg>
    `;
  } else if (reason === 'deleted') {
    title.textContent = 'Account Removed';
    msg.textContent = 'Your account has been deleted. Please contact support if you believe this is an error.';
    icon.innerHTML = `
      <svg viewBox="0 0 24 24" width="60" height="60" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="3 6 5 6 21 6"></polyline>
        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
        <line x1="10" y1="11" x2="10" y2="17"></line>
        <line x1="14" y1="11" x2="14" y2="17"></line>
      </svg>
    `;
  } else if (reason === 'role_change') {
    title.textContent = 'Access Changed';
    msg.textContent = 'Your permissions have been updated by an administrator. Please log in again to refresh your session.';
    icon.innerHTML = `
      <svg viewBox="0 0 24 24" width="60" height="60" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 15v-2c0-1.1.9-2 2-2h2V7c0-1.1-.9-2-2-2h-2c-1.1 0-2 .9-2 2v2H8c-1.1 0-2 .9-2 2v2c0 1.1.9 2 2 2h2v2c0 1.1.9 2 2 2h2c1.1 0 2-.9 2-2v-2h-2c-1.1 0-2-.9-2-2z"></path>
        <path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"></path>
      </svg>
    `;
  } else {
    // Default/fallback icon
    icon.innerHTML = `
      <svg viewBox="0 0 24 24" width="60" height="60" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round">
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
        <line x1="12" y1="9" x2="12" y2="13"></line>
        <line x1="12" y1="17" x2="12.01" y2="17"></line>
      </svg>
    `;
  }

  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';

  // Automatically logout after specified delay if they don't click OK
  setTimeout(() => performLogout(true), autoLogoutDelay);
}

async function checkFeedbackStatus() {
  try {
    const res = await fetch(`${API_URL}/settings/feedback-status`);
    const data = await res.json();
    const btn = document.querySelector('.feedback-float-btn');
    if (btn) {
      if (!data.enabled) {
        btn.classList.add('hidden');
      } else {
        btn.classList.remove('hidden');
      }
    }
  } catch (e) {}
}

// Function to get all the photos we saved
window.getAllPosts = async function(sort = '') {
  const url = new URL(`${API_URL}/posts`);
  url.searchParams.set('t', Date.now());
  if (sort) url.searchParams.set('sort', sort);

  const response = await fetch(url.toString(), { headers: getAuthHeaders() });
  if (!response.ok) return [];
  return response.json();
};

// Functions to handle Collections (Groups)
window.getAllCollections = async function() {
  const response = await fetch(`${API_URL}/collections`, { headers: getAuthHeaders() });
  if (!response.ok) return [];
  return response.json();
};

window.updateCollection = async function(collection) {
  await fetch(`${API_URL}/collections`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify(collection)
  });
};

// Function to delete a collection
window.deleteCollection = async function(name) {
  const response = await fetch(`${API_URL}/collections/${encodeURIComponent(name)}`, {
    method: 'DELETE',
    headers: getAuthHeaders()
  });
  if (!response.ok) throw new Error('Failed to delete collection');
  return response.json();
};

// Function to save a new photo post
window.addPost = async function(post) {
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
};

// Function to remove a photo by its ID
window.deletePost = async function(postId) {
  const response = await fetch(`${API_URL}/posts/${postId}`, {
    method: 'DELETE',
    headers: getAuthHeaders()
  });
  if (!response.ok) throw new Error('Failed to delete post');
};

// Utility to compress images before saving to IndexedDB
window.compressImage = async function(file, maxWidth = 1600, quality = 0.7) {
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
  
  // If it's an array, take the first element
  if (Array.isArray(data)) {
    if (data.length > 0) return window.resolveImgUrl(data[0]);
    return '';
  }

  // If it's a Blob, create an Object URL
  if (data instanceof Blob) return URL.createObjectURL(data);
  
  // At this point, it should be a string (base64 or URL)
  return String(data).trim().replace(/^"|"$/g, ''); // Remove surrounding quotes if present
};

// Moved from profile.html to be globally accessible
function openLogoutModal() {
  // This function is no longer needed as logout uses customConfirm directly
}

function closeLogoutModal() {
  // This function is no longer needed as closeConfirmModal is used
}

// Global helper to handle direct image downloads via API
window.downloadPost = async function(postId, index = 0) {
  if (!postId) return;
  
  showToast('Preparing download...', 'info');
  
  const url = `${API_URL}/posts/image/${postId}/${index}`;
  
  try {
    const response = await fetch(url, { headers: getAuthHeaders() });
    if (!response.ok) throw new Error('Server error');
    
    const blob = await response.blob();
    const blobUrl = window.URL.createObjectURL(blob);
    
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = `BeyondFrame-${postId}-${index}.jpg`;
    document.body.appendChild(link);
    link.click();
    
    // Cleanup
    document.body.removeChild(link);
    window.URL.revokeObjectURL(blobUrl);
    showToast('Download complete!', 'success');
  } catch (err) {
    console.error('Download failed:', err);
    showToast('Failed to download image. Try again.', 'error');
  }
};

// Global helper to toggle password visibility
window.togglePasswordVisibility = function(btnId, inputId) {
  const input = document.getElementById(inputId);
  const btn = document.getElementById(btnId);
  if (!input || !btn) return;

  const isPassword = input.type === 'password';
  input.type = isPassword ? 'text' : 'password';
  
  // Update SVG icon
  if (isPassword) {
    btn.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`;
    btn.title = "Hide Password";
  } else {
    btn.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`;
    btn.title = "Show Password";
  }
};

// This function is called by the "Yes, Logout" button in the custom modal
async function performLogout(force = false) {
  // Clear heartbeat interval if it's running
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
  
  // Close all open modals generically
  document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
  document.body.style.overflow = '';

  await window.logout(force); // Call the global logout function
}

window.sendLogoutRequest = async function(keepalive = false) {
  const token = localStorage.getItem('bf_token');
  if (!token || !API_URL) return;

  try {
    await fetch(`${API_URL}/logout`, {
      method: 'POST',
      headers: window.getAuthHeaders(),
      mode: 'cors',
      keepalive
    });
  } catch (error) {
    console.warn('Logout request failed:', error);
  }
};

window.unloadMarkInactive = function() {
  if (!API_URL || !localStorage.getItem('bf_token')) return;
  try {
    fetch(`${API_URL}/logout`, {
      method: 'POST',
      headers: window.getAuthHeaders(),
      mode: 'cors',
      keepalive: true
    });
  } catch (error) {
    console.warn('Unload logout failed:', error);
  }
};

window.logout = async function(force = false) { // 'force' is used for system-triggered logouts (e.g., after account deletion)
  if (force !== true) {
    const confirmed = await window.customConfirm('Logout', 'Are you sure you want to log out of BeyondFrame?', 'Yes, Logout', 'info');
    if (!confirmed) return;
  }

  await window.sendLogoutRequest(true);

  localStorage.removeItem('bf_token');
  localStorage.removeItem('bf_username');
  localStorage.removeItem('bf_role');
  window.location.href = 'index.html';
};

function parseJwt(token) {
  if (!token || !token.includes('.')) return null;
  try {
    return JSON.parse(atob(token.split('.')[1]));
  } catch (e) { return null; }
}

// Theme Management
function initTheme() {
  const savedTheme = localStorage.getItem('bf_theme') || 'system';
  const prefersLight = window.matchMedia('(prefers-color-scheme: light)').matches;

  if (savedTheme === 'light' || (savedTheme === 'system' && prefersLight)) {
    document.documentElement.classList.add('light-mode');
  }

  // Listen for system theme changes
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', e => {
    if ((localStorage.getItem('bf_theme') || 'system') === 'system') {
      document.documentElement.classList.toggle('light-mode', e.matches);
      const toggle = document.getElementById('theme-toggle');
      if (toggle && toggle.updateIcon) toggle.updateIcon();
    }
  });

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
  }

  const payload = token ? parseJwt(token) : null;
  if (nav) {
    if (payload) {
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
    }

    // Add Notification Bell for users
    if (payload && !document.getElementById('nav-notifications-btn')) {
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
  toggle.setAttribute('aria-label', 'Toggle theme');
  
  const updateIcon = () => {
    const theme = localStorage.getItem('bf_theme') || 'system';
    if (theme === 'system') {
      toggle.innerHTML = `
        <svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
          <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
          <line x1="8" y1="21" x2="16" y2="21"></line>
          <line x1="12" y1="17" x2="12" y2="21"></line>
        </svg>`;
      toggle.title = 'Current: System Default (Click for Light)';
    } else if (theme === 'light') {
      toggle.innerHTML = `
        <svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="5"></circle>
          <line x1="12" y1="1" x2="12" y2="3"></line>
          <line x1="12" y1="21" x2="12" y2="23"></line>
          <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>
          <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
          <line x1="1" y1="12" x2="3" y2="12"></line>
          <line x1="21" y1="12" x2="23" y2="12"></line>
          <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line>
          <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
        </svg>`;
      toggle.title = 'Current: Light Mode (Click for Dark)';
    } else {
      toggle.innerHTML = `
        <svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
        </svg>`;
      toggle.title = 'Current: Dark Mode (Click for System)';
    }
  };

  toggle.updateIcon = updateIcon;
  updateIcon();

  toggle.onclick = () => {
    const current = localStorage.getItem('bf_theme') || 'system';
    let next;
    if (current === 'system') next = 'light';
    else if (current === 'light') next = 'dark';
    else next = 'system';

    localStorage.setItem('bf_theme', next);
    
    const prefersLight = window.matchMedia('(prefers-color-scheme: light)').matches;
    if (next === 'light') {
      document.documentElement.classList.add('light-mode');
    } else if (next === 'dark') {
      document.documentElement.classList.remove('light-mode');
    } else {
      document.documentElement.classList.toggle('light-mode', prefersLight);
    }
    
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
          <button id="modal-prev" class="slider-nav-btn prev hidden" onclick="modalPrev()"><svg viewBox="0 0 24 24" width="24" height="24" stroke="currentColor" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg></button>
          <button id="modal-next" class="slider-nav-btn next hidden" onclick="modalNext()"><svg viewBox="0 0 24 24" width="24" height="24" stroke="currentColor" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg></button>
          <div id="modal-counter" class="image-counter hidden"></div>
          <div id="modal-dots" class="modal-dots hidden"></div>
          <img id="modal-image" src="" alt="" onclick="handleImageTapInModal()">
          <button id="toggle-details-btn" class="theme-toggle" onclick="toggleModalDetails()" style="position:absolute; top:15px; left:15px; background:rgba(0,0,0,0.5); border:1px solid rgba(255,255,255,0.2); color:white; width:38px; height:38px; z-index:10;" title="Hide Details">
            <svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 12h16M4 18h16"></path></svg>
          </button>
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
              <button id="modal-review" class="action-btn">
                <svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path>
                </svg>
                <span id="modal-review-count">0</span>
              </button>
              <div style="position: relative; display: flex; align-items: center;">
              <button class="menu-btn" onclick="toggleModalMenu(event)" title="Options">
                <svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="12" cy="12" r="1"></circle><circle cx="19" cy="12" r="1"></circle><circle cx="5" cy="12" r="1"></circle>
                </svg>
              </button>
                <div id="modal-menu-dropdown" class="menu-dropdown" style="top: auto; bottom: calc(100% + 10px); left: 50%; transform: translateX(-50%); right: auto;">
                  <button id="modal-edit-btn" onclick="editPostFromModal()">Edit</button>
                  <button onclick="sharePostFromModal()">Share</button>
                  <button onclick="reportPostFromModal()" style="color:#ff9800">Report 18+</button>
                <button id="modal-download-btn">Download</button>
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
      <div class="modal-content" style="max-width: 320px;">
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

    <div id="confirm-action-modal" class="modal hidden">
      <div class="modal-overlay" onclick="closeConfirmModal()"></div>
      <div class="modal-content" style="max-width: 440px;">
        <button class="modal-close" onclick="closeConfirmModal()">&times;</button>
        <div class="modal-details confirm-modal-details">
          <div id="confirm-icon-container" class="confirm-icon-container">
            <svg id="confirm-icon" viewBox="0 0 24 24" width="42" height="42" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"></svg>
          </div>
          <h3 id="confirm-title">Are you sure?</h3>
          <p id="confirm-message">This action cannot be undone.</p>
          <div class="confirm-actions">
            <button id="confirm-cancel-btn" class="button secondary-button">Cancel</button>
            <button id="confirm-btn" class="button confirm-button">Confirm</button>
          </div>
        </div>
      </div>
    </div>

    <div id="big-screen-overlay" class="modal hidden">
      <div class="modal-overlay" onclick="closeBigScreen()"></div>
      <div class="modal-content">
        <button class="modal-close" onclick="closeBigScreen()">&times;</button>
        <div class="options-container">
          <button class="menu-btn" onclick="toggleModalMenu(event)" title="Options">
            <svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="1"></circle><circle cx="19" cy="12" r="1"></circle><circle cx="5" cy="12" r="1"></circle>
            </svg>
          </button>
          <div class="menu-dropdown">
            <button onclick="sharePostFromModal()">Share</button>
            <button id="big-screen-download-btn">Download</button>
            <button onclick="reportPostFromModal()" style="color:#ff9800">Report 18+</button>
            <button id="big-screen-edit-btn" onclick="editPostFromModal()">Edit</button>
            <button id="big-screen-delete-btn" onclick="deletePostFromModal()" style="color:#ff4d4d">Delete</button>
          </div>
        </div>
        <div class="modal-image-container">
          <button class="slider-nav-btn prev" onclick="modalPrev()"><svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg></button>
          <button class="slider-nav-btn next" onclick="modalNext()"><svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg></button>
          <div class="image-counter"></div>
          <img id="big-screen-image" src="" alt="">
        </div>
      </div>
    </div>

    <div id="system-kickout-modal" class="modal hidden" style="z-index: 5000;">
      <div class="modal-overlay"></div>
      <div class="modal-content" style="max-width: 400px; text-align: center;">
        <div class="modal-details">
          <div id="kickout-icon" style="font-size: 4rem; margin-bottom: 1rem;">⚠️</div>
          <h3 id="kickout-title">Session Ended</h3>
          <p id="kickout-message" style="margin-bottom: 2rem;"></p>
          <button class="button" style="width: 100%;" onclick="performLogout(true)">OK</button>
        </div>
      </div>
    </div>

    <div id="delete-account-modal" class="modal hidden">
      <div class="modal-overlay" onclick="closeDeleteAccountModal()"></div>
      <div class="modal-content" style="max-width: 400px; text-align: center;">
        <div class="modal-details">
          <div style="color: #ff4d4d; margin-bottom: 1rem; display: flex; justify-content: center; filter: drop-shadow(0 0 10px rgba(255, 77, 77, 0.3));">
            <svg viewBox="0 0 24 24" width="60" height="60" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
              <line x1="10" y1="11" x2="10" y2="17"></line>
              <line x1="14" y1="11" x2="14" y2="17"></line>
            </svg>
          </div>
          <h3 style="color: #ff4d4d;">Delete Account</h3>
          <p>This action is <strong>irreversible</strong> and will remove all your data. Please enter your password to confirm.</p>
          <div class="form-group" style="margin-top: 1.5rem; text-align: left;">
            <label>Confirm Password</label>
            <div class="password-wrapper">
              <input type="password" id="delete-confirm-password" placeholder="Enter your password" style="width: 100%;" />
              <button type="button" class="password-toggle-btn" id="delete-pass-toggle" onclick="togglePasswordVisibility('delete-pass-toggle', 'delete-confirm-password')" title="Show Password">
                <svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>
              </button>
            </div>
          </div>
          <div style="display: flex; gap: 1rem; margin-top: 2rem;">
            <button class="button" style="flex: 1; background: var(--bg-color); border: 1px solid var(--border-color); color: var(--text-color);" onclick="closeDeleteAccountModal()">Cancel</button>
            <button class="button" style="flex: 1; background: #ff4d4d; color: white;" onclick="processAccountDeletion()">Delete Forever</button>
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
            <div class="password-wrapper">
              <input type="password" id="reset-new-password" placeholder="At least 8 characters" required minlength="8" />
              <button type="button" class="password-toggle-btn" id="reset-pass-toggle" onclick="togglePasswordVisibility('reset-pass-toggle', 'reset-new-password')" title="Show Password">
                <svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>
              </button>
            </div>
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

    <button class="feedback-float-btn" onclick="openFeedbackModal()" title="Give Feedback">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="28" height="28">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
      </svg>
    </button>

    <div id="feedback-modal" class="modal hidden">
      <div class="modal-overlay" onclick="closeFeedbackModal()"></div>
      <div class="modal-content" style="max-width: 400px;">
        <button class="modal-close" onclick="closeFeedbackModal()">&times;</button>
        <div class="modal-details">
          <h3>Community Feedback</h3>
          <p style="opacity: 0.7; font-size: 0.9rem;">Have a suggestion or found a bug? Let us know!</p>
          <div class="form-group" style="margin-top: 1.5rem;">
            <textarea id="feedback-message" rows="5" placeholder="Your message here..." style="width: 100%; padding: 1rem; border-radius: 0.8rem; background: var(--bg-color); color: var(--text-color); border: 1px solid var(--border-color); resize: none;" onkeydown="if(event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submitFeedback(); }"></textarea>
          </div>
          <button class="button" style="width: 100%; margin-top: 1rem;" onclick="submitFeedback()">Send Feedback</button>
        </div>
      </div>
    </div>

    <div id="toast-container"></div>
  `;
  document.body.insertAdjacentHTML('beforeend', modalHTML);
}

window.closeConfirmModal = function() {
  const modal = document.getElementById('confirm-action-modal');
  if (modal) modal.classList.add('hidden');
  document.body.style.overflow = '';
};

// Custom Styled Confirm Replacement
window.customConfirm = function(title, message, confirmText = 'Confirm', type = 'info') {
  return new Promise((resolve) => {
    const modal = document.getElementById('confirm-action-modal');
    if (!modal) {
      resolve(confirm(message));
      return;
    }

    const iconContainer = document.getElementById('confirm-icon-container');
    const iconSvg = document.getElementById('confirm-icon');
    const titleEl = document.getElementById('confirm-title');
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-message').textContent = message;
    const btn = document.getElementById('confirm-btn');
    const cancelBtn = document.getElementById('confirm-cancel-btn');
    btn.textContent = confirmText;

    // Set button styles based on type
    if (type === 'danger') {
      btn.style.background = '#ff4d4d';
      btn.style.color = 'white';
      titleEl.style.color = '#ff4d4d'; // Make title red for danger
      iconContainer.style.color = '#ff4d4d';
      iconSvg.innerHTML = `<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line>`; // Warning icon
    } else {
      btn.style.background = 'var(--accent-color)';
      btn.style.color = 'white';
      titleEl.style.color = 'var(--text-color)'; // Default title color
      iconContainer.style.color = 'var(--accent-color)';
      iconSvg.innerHTML = `<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 0 1-3.46 0"></path>`; // Info/Bell icon
    }
    iconContainer.style.filter = `drop-shadow(0 0 10px ${iconContainer.style.color}33)`; // Subtle glow
    iconSvg.style.display = 'block';
    
    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    
    btn.onclick = () => { window.closeConfirmModal(); resolve(true); };
    cancelBtn.onclick = () => { window.closeConfirmModal(); resolve(false); };
  });
};

window.initiatePasswordReset = function() {
  const modal = document.getElementById('email-prompt-modal');
  if (modal) {
    modal.classList.remove('hidden');
    document.getElementById('reset-email-prompt').focus();
  }
};

window.closeEmailPromptModal = function() {
  document.getElementById('email-prompt-modal').classList.add('hidden');
  document.getElementById('email-prompt-form').reset();
};

window.closeResetPasswordModal = function() {
  document.getElementById('reset-password-modal').classList.add('hidden');
  document.getElementById('password-reset-form').reset();
};

window.submitCommentFromModal = function() {
  window.submitComment(window.currentViewingPostId, 'modal-comment-input');
};

window.submitReviewFromModal = function() {
  window.submitComment(window.currentViewingPostId, 'modal-comment-input-bulk');
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

// Auto-initialize the portal and theme when the page loads
document.addEventListener('DOMContentLoaded', initApp);

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

window.closeDeleteAccountModal = function() { // Re-added for the dedicated delete account modal
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
window.currentViewingPostType = 'image';
let currentCollectionPostIds = null;
async function openModal(images, index, title, description, meta, postId, author, collectionPostIds = null, mediaType = 'image') {
  // Support both multi-image albums (new signature) and single legacy calls
  if (typeof index === 'number' || postId !== undefined) {
    currentModalImages = Array.isArray(images) ? images : [images];
    currentModalIndex = index || 0;
    currentModalTitle = title;
    currentModalDesc = description;
    currentModalMeta = meta;
    window.currentViewingPostId = postId;
    currentModalAuthor = author;
    window.currentViewingPostType = mediaType;
    currentCollectionPostIds = collectionPostIds;
  } else {
    // Legacy signature: images=src, index=title, title=desc, description=meta
    currentModalImages = [images];
    currentModalIndex = 0;
    currentModalTitle = index || '';
    currentModalDesc = title;
    currentModalMeta = description;
    window.currentViewingPostId = null;
    currentModalAuthor = '';
    window.currentViewingPostType = 'image';
    currentCollectionPostIds = null;
  }

  await updateModalUI();
  document.getElementById('modal').classList.remove('hidden');

  document.body.style.overflow = 'hidden'; // Prevent background scroll
}

window.toggleModalDetails = function() {
  const modalContent = document.querySelector('#modal .modal-content');
  const modalDetails = document.querySelector('#modal .modal-details');
  const toggleBtn = document.getElementById('toggle-details-btn');

  if (modalContent && modalDetails && toggleBtn) {
    const isDetailsHidden = modalDetails.classList.toggle('hidden');
    modalContent.classList.toggle('details-hidden', isDetailsHidden);
    toggleBtn.innerHTML = isDetailsHidden ? `<svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M18 15l-6-6-6 6"></path></svg>` : `<svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 12h16M4 18h16"></path></svg>`;
    toggleBtn.title = isDetailsHidden ? "Show Details" : "Hide Details";
  }
};

async function updateModalUI() {
  const data = currentModalImages[currentModalIndex];
  const src = window.resolveImgUrl(data);
  
  const container = document.querySelector('.modal-image-container');
  const isVideo = window.currentViewingPostType === 'video';

  container.innerHTML = `
    <button id="modal-prev" class="slider-nav-btn prev hidden" onclick="modalPrev()"><svg viewBox="0 0 24 24" width="24" height="24" stroke="currentColor" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg></button>
    <button id="modal-next" class="slider-nav-btn next hidden" onclick="modalNext()"><svg viewBox="0 0 24 24" width="24" height="24" stroke="currentColor" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg></button>
    <div id="modal-counter" class="image-counter hidden"></div>
    <div id="modal-dots" class="modal-dots hidden"></div>
    ${isVideo ? 
      `<div class="modal-video-wrapper" onclick="handleImageTapInModal()"> <!-- Tap on video wrapper toggles details -->
         <video id="modal-video" src="${src}" autoplay loop muted playsinline></video>
         <button id="video-mute-btn" class="theme-toggle" onclick="toggleModalVideoMute(event)" style="position:absolute; bottom:15px; right:15px; background:rgba(0,0,0,0.5); border:1px solid rgba(255,255,255,0.2); color:white; width:38px; height:38px; z-index:10;" title="Toggle Mute">
           <svg id="mute-icon" viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
             <path d="M11 5L6 9H2v6h4l5 4V5z"></path><line x1="23" y1="9" x2="17" y2="15"></line><line x1="17" y1="9" x2="23" y2="15"></line>
           </svg>
         </button>
         <div class="video-seekbar-container">
           <div class="video-seekbar" id="modal-video-seekbar"></div>
           <div class="video-time-display"><span id="modal-video-current-time">0:00</span> / <span id="modal-video-duration">0:00</span></div>
         </div>
         <button id="video-play-pause-btn" class="video-overlay-btn" onclick="toggleModalVideoPlayPause(event)" title="Play/Pause">
           <svg id="play-pause-icon" viewBox="0 0 24 24" width="24" height="24" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
             <polygon points="5 3 19 12 5 21 5 3"></polygon>
           </svg>
         </button>
       </div>` :
      `<img id="modal-image" src="${src}" alt="" onclick="handleImageTapInModal()">`
    }
  `;

  document.getElementById('modal-title').textContent = currentModalTitle;
  document.getElementById('modal-description').textContent = currentModalDesc;
  document.getElementById('modal-meta').textContent = currentModalMeta;
  const modalDownloadBtn = document.getElementById('modal-download-btn');
  if (modalDownloadBtn) {
    modalDownloadBtn.onclick = (e) => { e.stopPropagation(); downloadPost(window.currentViewingPostId, currentModalIndex); };
  }
  
  const prevBtn = document.getElementById('modal-prev');
  const nextBtn = document.getElementById('modal-next');
  const counter = document.getElementById('modal-counter');
  const dotsContainer = document.getElementById('modal-dots');
  
  if (prevBtn && nextBtn && counter && dotsContainer) {
    const isAlbum = currentModalImages.length > 1;
    prevBtn.classList.toggle('hidden', !isAlbum);
    nextBtn.classList.toggle('hidden', !isAlbum);
    counter.classList.toggle('hidden', !isAlbum);
    dotsContainer.classList.toggle('hidden', !isAlbum);

    if (isAlbum) {
      counter.textContent = `${currentModalIndex + 1} / ${currentModalImages.length}`;
      dotsContainer.innerHTML = currentModalImages.map((_, i) => `<span class="dot ${i === currentModalIndex ? 'active' : ''}" onclick="goToModalImage(${i})"></span>`).join('');
    }
    
    // Add touch event listeners for swipe navigation
    addSwipeListeners(container, modalNext, modalPrev);

    // Initialize video play/pause state and listeners
    if (isVideo) {
      const videoElement = document.getElementById('modal-video');
      if (videoElement) {
        videoElement.onplay = updateModalVideoPlayPauseIcon;
        videoElement.onpause = updateModalVideoPlayPauseIcon;
        videoElement.ontimeupdate = updateModalVideoSeekbar;
        videoElement.onloadedmetadata = updateModalVideoSeekbar;
        updateModalVideoPlayPauseIcon(); // Set initial icon state
        setupModalVideoSeekbarListeners();
      }
    }
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
  const reviewBtn = document.getElementById('modal-review');
  const commentsList = document.getElementById('modal-comments-list');

  if (window.currentViewingPostId && likeBtn && saveBtn && reviewBtn) {
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

      reviewBtn.onclick = () => window.openCommentModal(post.id);
      const countSpan = document.getElementById('modal-review-count');
      if (countSpan) {
        countSpan.textContent = window.calculateTotalComments(post);
      }

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

window.toggleModalVideoMute = function(e) {
  if (e) e.stopPropagation();
  const video = document.getElementById('modal-video');
  const btn = document.getElementById('video-mute-btn');
  if (!video || !btn) return;

  video.muted = !video.muted;
  
  // Update Icon based on state
  if (video.muted) {
    btn.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H2v6h4l5 4V5z"></path><line x1="23" y1="9" x2="17" y2="15"></line><line x1="17" y1="9" x2="23" y2="15"></line></svg>`;
  } else {
    btn.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H2v6h4l5 4V5z"></path><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>`;
  }
};

window.toggleModalVideoPlayPause = function(e) {
  if (e) e.stopPropagation(); // Prevent tap from triggering handleImageTapInModal
  const video = document.getElementById('modal-video');
  if (!video) return;

  if (video.paused) {
    video.play();
  } else {
    video.pause();
  }
  updateModalVideoPlayPauseIcon();
};

function updateModalVideoPlayPauseIcon() {
  const video = document.getElementById('modal-video');
  const btn = document.getElementById('video-play-pause-btn');
  if (!video || !btn) return;

  const icon = btn.querySelector('#play-pause-icon');
  if (icon) {
    icon.innerHTML = video.paused ? `<polygon points="5 3 19 12 5 21 5 3"></polygon>` : `<rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect>`;
  }
}

function formatTime(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  return `${minutes}:${remainingSeconds < 10 ? '0' : ''}${remainingSeconds}`;
}

function updateModalVideoSeekbar() {
  const video = document.getElementById('modal-video');
  const seekbar = document.getElementById('modal-video-seekbar');
  const currentTimeSpan = document.getElementById('modal-video-current-time');
  const durationSpan = document.getElementById('modal-video-duration');

  if (video && seekbar && currentTimeSpan && durationSpan) {
    const progress = (video.currentTime / video.duration) * 100;
    seekbar.style.width = `${progress}%`;
    currentTimeSpan.textContent = formatTime(video.currentTime);
    durationSpan.textContent = formatTime(video.duration);
  }
}

function setupModalVideoSeekbarListeners() {
  const video = document.getElementById('modal-video');
  const seekbarContainer = document.querySelector('.video-seekbar-container');
  if (!video || !seekbarContainer) return;

  let isSeeking = false;

  seekbarContainer.addEventListener('mousedown', (e) => {
    isSeeking = true;
    seekVideo(e);
  });

  document.addEventListener('mousemove', (e) => {
    if (isSeeking) seekVideo(e);
  });

  document.addEventListener('mouseup', () => {
    isSeeking = false;
  });

  function seekVideo(e) {
    const rect = seekbarContainer.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    video.currentTime = (clickX / rect.width) * video.duration;
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
  const posts = (window.cachedPosts && window.cachedPosts.length) ? window.cachedPosts : 
                ((window.allPostsCache && window.allPostsCache.length) ? window.allPostsCache : await getAllPosts());
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
  if (!(await window.customConfirm('Delete Review', 'Delete this review? This action cannot be undone.', 'Delete', 'danger'))) return;
  const posts = (window.cachedPosts && window.cachedPosts.length) ? window.cachedPosts : 
                ((window.allPostsCache && window.allPostsCache.length) ? window.allPostsCache : await getAllPosts());
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
    // 1. Immediate UI update (Optimistic)
    refreshUIGrids(true); 
    updateModalUI();
    const commentModal = document.getElementById('comment-modal');
    if (commentModal && !commentModal.classList.contains('hidden')) {
      window.openCommentModal(postId);
    }

    // 2. Background server update (Non-blocking)
    addPost(post).then(() => {
      showToast("Deleted.", "success");
    }).catch(err => {
      console.error("Deletion sync failed:", err);
      showToast("Sync failed. Please refresh to see the true state.", "error");
    });
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

  // Use existing cache to avoid re-fetching the whole database just to add a comment
  const posts = (window.cachedPosts && window.cachedPosts.length) ? window.cachedPosts : 
                ((window.allPostsCache && window.allPostsCache.length) ? window.allPostsCache : await getAllPosts());

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
    refreshUIGrids(true);
  }
};

window.closeCommentModal = function() {
  const modal = document.getElementById('comment-modal');
  if (modal) modal.classList.add('hidden');
  window.currentViewingPostId = null;
};

window.submitReply = async function(postId, reviewId, isBulk = false) {
  const prefix = isBulk ? 'bulk-' : '';
  const input = document.getElementById(`${prefix}input-field-${reviewId}`);
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  const token = localStorage.getItem('bf_token'); // Re-fetch token for freshness
  const userPayload = token ? parseJwt(token) : null; // Re-parse payload
  const currentUsername = (userPayload && userPayload.username) || localStorage.getItem('bf_username') || 'User';
  
  const posts = (window.cachedPosts && window.cachedPosts.length) ? window.cachedPosts : 
                ((window.allPostsCache && window.allPostsCache.length) ? window.allPostsCache : await getAllPosts());

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
    refreshUIGrids(true);
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
      
      // Update local state in all possible caches
      const updater = (post) => {
        if (post.id === postId) {
          post.userLiked = (data.status === 'liked');
          post.likes = (post.likes || 0) + (data.status === 'liked' ? 1 : -1);
        }
      };
      if (window.cachedPosts) window.cachedPosts.forEach(updater);
      if (window.allPostsCache) window.allPostsCache.forEach(updater);

      if (window.currentViewingPostId === postId) {
        updateModalUI();
      }
      refreshUIGrids(true);
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

window.loadModerationQueue = async function() {
  const container = document.getElementById('admin-moderation-list');
  if (!container) return;
  
  container.innerHTML = '<p style="opacity:0.6; font-style:italic;">Scanning for flagged content...</p>';
  
  try {
    const res = await fetch(`${API_URL}/admin/moderation-queue`, { headers: getAuthHeaders() });
    if (res.ok) {
      const queue = await res.json();
      if (queue.length === 0) {
        container.innerHTML = '<p style="opacity:0.6;">All clear! No posts are currently flagged for review.</p>';
        return;
      }
      
      container.innerHTML = queue.map(post => {
        const reportList = JSON.parse(post.reports || '[]');
        const reason = post.is_nsfw ? 'AI Flagged' : `${reportList.length} User Reports`;
        
        return `
          <div class="modal-comment-item" style="display:flex; justify-content:space-between; align-items:center; border-left: 4px solid #ff9800; padding-left:1rem;">
            <div>
              <div style="font-weight:700;">${escapeHTML(post.title)}</div>
              <div style="font-size:0.8rem; opacity:0.7;">By ${escapeHTML(post.author)} • <span style="color:#ff9800; font-weight:bold;">${reason}</span></div>
            </div>
            <div style="display:flex; gap:0.5rem;">
              <button class="button" style="padding:0.4rem 0.8rem; font-size:0.8rem;" onclick="switchToPost('${post.id}')">View</button>
              <button class="button" style="padding:0.4rem 0.8rem; font-size:0.8rem; background:#40c057; color:white;" onclick="approvePost('${post.id}')">Approve</button>
              <button class="button" style="padding:0.4rem 0.8rem; font-size:0.8rem; background:#ff4d4d; color:white;" onclick="deletePostUI('${post.id}')">Delete</button>
            </div>
          </div>
        `;
      }).join('');
    }
  } catch (e) {
    container.innerHTML = '<p style="color:#ff4d4d;">Failed to load moderation queue.</p>';
  }
};

window.approvePost = async function(postId) {
  if (await window.customConfirm('Approve Post', 'This will clear all NSFW flags and user reports. Continue?', 'Approve', 'info')) {
    try {
      const res = await fetch(`${API_URL}/admin/posts/${postId}/approve`, {
        method: 'PATCH',
        headers: getAuthHeaders()
      });
      if (res.ok) {
        showToast('Post approved', 'success');
        window.loadModerationQueue();
        refreshUIGrids();
      } else {
        showToast('Approval failed', 'error');
      }
    } catch (err) {
      showToast('Network error', 'error');
    }
  }
};

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
        if (n.type === 'like') msg = `liked your post "<b>${escapeHTML(n.postTitle)}</b>"`;
        if (n.type === 'comment') msg = `commented on your post "<b>${escapeHTML(n.postTitle)}</b>"`;
        if (n.type === 'reply') msg = `replied to your review on "<b>${escapeHTML(n.postTitle)}</b>"`;
        if (n.type === 'feedback') msg = `sent new community feedback`;
        
        return `
          <div onclick="navigateToPostFromNote('${n.postId}', '${n.type}')" style="cursor: pointer; padding: 0.75rem; border-bottom: 1px solid var(--border-color); font-size: 0.9rem; ${n.isRead ? 'opacity: 0.6;' : 'background: rgba(77,171,247,0.05); border-left: 3px solid var(--accent-color);'}">
            <b>${escapeHTML(n.actorName)}</b> ${msg}
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
  if (type === 'feedback') {
    if (window.location.pathname.includes('admin.html')) {
      switchAdminTab('feedback');
    } else {
      window.location.href = 'admin.html?tab=feedback';
    }
    return;
  }
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
  window.currentViewingPostType = post.mediaType || 'image';
  currentModalAuthor = post.author;

  updateModalUI();
  document.getElementById('modal').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function refreshUIGrids(skipFetch = false) {
  if (window.renderHomePreview) {
    if (!skipFetch && window.cachedPosts) window.cachedPosts = []; 
    window.renderHomePreview(window.currentAuthorFilter, skipFetch);
  }
  if (window.renderCollections) {
    window.renderCollections();
  }
  if (window.renderPosts) {
    const fetchAction = skipFetch ? Promise.resolve(window.allPostsCache) : getAllPosts();
    fetchAction.then(posts => {
      window.allPostsCache = posts;
      window.renderPosts(posts, skipFetch);
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

function handleImageTapInModal() {
  const modal = document.getElementById('modal');
  if (!modal) return;

  const content = modal.querySelector('.modal-content');
  const isMobile = window.innerWidth <= 768;

  if (isMobile) {
    toggleModalDetails(); // Toggle the details section
  } else {
    openBigScreen(); // Desktop behavior: go to zoom/pan mode
  }
}

function openBigScreen() {
  const bigOverlay = document.getElementById('big-screen-overlay');
  const bigImg = document.getElementById('big-screen-image');
  const modalImg = document.getElementById('modal-image');
  
  if (bigOverlay && bigImg && modalImg) {
    bigImg.src = modalImg.src;
    
    // Sync the download button
    const bigDownloadBtn = document.getElementById('big-screen-download-btn');
    if (bigDownloadBtn) bigDownloadBtn.dataset.url = modalImg.src;
    
    const token = localStorage.getItem('bf_token');
    const userPayload = token ? parseJwt(token) : null;
    const isModOrAdmin = userPayload && (userPayload.role === 'admin' || userPayload.role === 'moderator');
    const isOwner = getCurrentUser() === currentModalAuthor;

    document.getElementById('big-screen-delete-btn').style.display = (isOwner || isModOrAdmin) ? 'block' : 'none';
    document.getElementById('big-screen-edit-btn').style.display = isOwner ? 'block' : 'none';

    bigOverlay.classList.remove('hidden');
    updateBigScreenImage();

    // Attach zoom and pan handlers for Big Screen
    const container = bigOverlay.querySelector('.modal-image-container');
    // Fix: Attach dblclick listener after a short delay to prevent immediate trigger from opening dblclick
    setTimeout(() => { container.ondblclick = handleBigScreenZoom; }, 100);
    container.onmousemove = handleBigScreenPan; // Pan can be attached immediately
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
    const bigDownloadBtn = document.getElementById('big-screen-download-btn');
    if (bigDownloadBtn) {
      bigDownloadBtn.onclick = (e) => { e.stopPropagation(); downloadPost(window.currentViewingPostId, currentModalIndex); };
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
  const btn = e.currentTarget;
  const dropdown = btn.nextElementSibling;
  
  // Close any other open menus first
  document.querySelectorAll('.menu-dropdown').forEach(d => {
    if (d !== dropdown) d.style.display = 'none';
  });

  if (dropdown) dropdown.style.display = dropdown.style.display === 'flex' ? 'none' : 'flex';
}

function sharePostFromModal() {
  document.querySelectorAll('.menu-dropdown').forEach(d => d.style.display = 'none');
  if (window.sharePost) window.sharePost(window.currentViewingPostId, currentModalIndex);
}

function deletePostFromModal() {
  if (window.deletePostUI) {
    document.querySelectorAll('.menu-dropdown').forEach(d => d.style.display = 'none');
    window.deletePostUI(window.currentViewingPostId);
  }
}

window.reportPostFromModal = async function() {
  document.querySelectorAll('.menu-dropdown').forEach(d => d.style.display = 'none');
  if (await window.customConfirm('Report Content', 'Is this post 18+ or violating guidelines?', 'Report', 'danger')) {
    try {
      const res = await fetch(`${API_URL}/posts/report`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ postId: window.currentViewingPostId })
      });
      const data = await res.json();
      if (res.ok) {
        showToast(data.message, 'success');
        closeModal();
        refreshUIGrids();
      } else {
        showToast(data.error, 'error');
      }
    } catch (err) {
      showToast('Network error', 'error');
    }
  }
};

window.deletePostUI = async function(id) {
  if (await window.customConfirm('Delete Post?', 'This album and its contents will be permanently removed.', 'Delete', 'danger')) {
    postIdToDelete = id;
    confirmDeletePost();
  }
};

window.confirmDeletePost = async function() {
  if (!postIdToDelete) return;
  try {
    await deletePost(postIdToDelete);
    refreshUIGrids();
    closeModal(); // Closes main modal or fullscreen lightbox
  } catch (err) {
    showToast('Failed to delete: ' + err.message, 'error');
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
  document.querySelectorAll('.menu-dropdown').forEach(d => d.style.display = 'none');
  if (window.editPost) window.editPost(window.currentViewingPostId); // Use currentViewingPostId
}

window.calculateTotalComments = function(post) {
  if (!post || !post.reviews) return 0;
  return post.reviews.reduce((acc, r) => acc + 1 + (r.replies ? r.replies.length : 0), 0);
};

window.goToModalImage = function(index) {
  currentModalIndex = index;
  updateModalUI();
};

// Close modal dropdowns on outside click
window.addEventListener('click', () => {
  document.querySelectorAll('.menu-dropdown').forEach(d => d.style.display = 'none');
});

async function modalNext() {
  if (currentModalImages.length > 1 && currentModalIndex < currentModalImages.length - 1) {
    currentModalIndex++;
    updateModalUI();
  } else if (currentCollectionPostIds) {
    const idx = currentCollectionPostIds.indexOf(window.currentViewingPostId);
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
    const idx = currentCollectionPostIds.indexOf(window.currentViewingPostId);
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

// Global Keyboard Navigation for Modals
window.addEventListener('keydown', (e) => {
  const modal = document.getElementById('modal');
  if (!modal || modal.classList.contains('hidden')) return;
  if (e.key === 'ArrowRight') modalNext();
  if (e.key === 'ArrowLeft') modalPrev();
});

// Procedural Beach Animations
function initBeachAnimations() {
  const overlay = document.getElementById('startup-overlay');
  const sea = document.querySelector('.sea');
  if (!sea || !overlay || !document.documentElement.classList.contains('light-mode')) return;

  // Sunlight Reflection Parallax
  overlay.addEventListener('mousemove', (e) => {
    const reflection = document.querySelector('.sunlight-reflection');
    if (!reflection) return;
    const x = (e.clientX / window.innerWidth - 0.5) * 15;
    reflection.style.transform = `translateX(${x * 2}px)`;
  });

  // Physics Nodes
  for (let i = 0; i < 10; i++) {
    const node = document.createElement('div');
    node.className = 'physics-node';
    node.style.left = `${Math.random() * 100}%`;
    node.style.top = `${Math.random() * 100}%`;
    node.style.animationDelay = `${Math.random() * -4}s`;
    sea.appendChild(node);
  }

  const spawnCurveChain = (topPos = Math.random() * 100, leftPos = -5 + Math.random() * 105, isMerged = false) => {
    const overlay = document.getElementById('startup-overlay');
    if (!overlay || overlay.classList.contains('fade-out')) return;

    const curve = document.createElement('div');
    curve.className = 'curve-line' + (isMerged ? ' merging' : '');

    const proximity = topPos / 100;
    const driftX = (Math.random() - 0.5) * 250;
    const travelY = 10 + Math.random() * 40;

    const width = (120 + Math.random() * 200) * (1 + proximity);
    const height = (12 + Math.random() * 12) * (1.8 - proximity);
    const duration = 5000 + Math.random() * 10000;
    
    const foamOpacity = 0.4 + (proximity * 0.5);
    const r1 = 90 + Math.random() * 30;
    const r2 = 90 + Math.random() * 30;
    const r3 = 100;
    const r4 = 100;

    const baseStyles = `top: ${topPos}%; left: ${leftPos}%; width: ${width}px; height: ${height}px; animation-duration: ${duration}ms; border-radius: ${r1}% ${r2}% 0 0 / ${r3}% ${r4}% 0 0; --drift-x: ${driftX}px; --travel-y: ${travelY}px; --peak-opacity: ${foamOpacity};`;

    curve.style.cssText = baseStyles;

    sea.appendChild(curve);
    
    setTimeout(() => {
      if (!document.getElementById('startup-overlay')) return;
      let nextTop, nextLeft;
      if (Math.random() > 0.85) {
        nextTop = Math.random() * 100;
        nextLeft = -5 + Math.random() * 105;
      } else {
        nextTop = Math.max(0, Math.min(100, topPos + (Math.random() - 0.5) * 40));
        nextLeft = Math.max(-5, Math.min(105, leftPos + (Math.random() - 0.5) * 60));
      }
      
      spawnCurveChain(nextTop, nextLeft, true);
      curve.classList.add('merging');
    }, duration * 0.85);

    curve.addEventListener('animationend', () => curve.remove());
  };

  for (let i = 0; i < 35; i++) spawnCurveChain(Math.random() * 80 + 10);
}

// Hides the modal pop-up
function closeModal() {
  const modal = document.getElementById('modal');
  if (modal) {
    modal.classList.add('hidden');
    closeBigScreen();
    // Reset modal details state when closing
    const modalContent = document.querySelector('#modal .modal-content');
    const modalDetails = document.querySelector('#modal .modal-details');
    const toggleBtn = document.getElementById('toggle-details-btn');
    if (modalContent && modalDetails && toggleBtn) {
      modalDetails.classList.remove('hidden');
      modalContent.classList.remove('details-hidden');
      toggleBtn.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 12h16M4 18h16"></path></svg>`;
      toggleBtn.title = "Hide Details";
    }
    document.body.style.overflow = ''; // Restore scroll
  }
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

window.openFeedbackModal = function() {
  document.getElementById('feedback-modal').classList.remove('hidden');
  document.getElementById('feedback-message').focus();
};

window.closeFeedbackModal = function() {
  document.getElementById('feedback-modal').classList.add('hidden');
  document.getElementById('feedback-message').value = '';
};

window.submitFeedback = async function() {
  const messageInput = document.getElementById('feedback-message');
  const message = messageInput.value.trim();
  if (!message) {
    showToast('Please enter a message', 'error');
    return;
  }

  try {
    const res = await fetch(`${API_URL}/feedback`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ message })
    });
    
    if (res.ok) {
      showToast('Thank you for your feedback!', 'success');
      closeFeedbackModal();
    } else {
      const data = await res.json().catch(() => ({ error: 'Failed to send feedback' }));
      showToast(data.error || 'Failed to send feedback', 'error');
    }
  } catch (err) {
    showToast('Network error', 'error');
  }
};

/**
 * Global Toast Notification System
 */
window.showToast = function(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('fade-out');
    setTimeout(() => toast.remove(), 500);
  }, 4000);
};