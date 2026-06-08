================================================
PROJECT EXPLANATION: BeyondFrame
================================================

1. OVERVIEW
-----------
BeyondFrame is a full-stack photography community platform. It allows users to 
create accounts, share high-quality scenes, and organize content into curated 
collections. The project features a custom Python-based threaded HTTP server and 
a lightweight SQLite database for a fast, persistent experience.

2. TECH STACK
-------------
- HTML5: Semantic structure of the web pages.
- CSS3: Custom styling using CSS Variables for theming and a "Soft Paper" aesthetic.
- Vanilla JavaScript: Handles all application logic without external frameworks.
- Python (http.server): A custom threaded HTTP server using the standard library.
- SQLite: A lightweight local file-based database (users.db) with WAL enabled.
- JWT (JSON Web Tokens): Secure, stateless authentication for user sessions.
- PWA: Progressive Web App features for offline access and installability.

3. FILE STRUCTURE & PAGE ROLES
------------------------------
- index.html (Home): The landing page. It fetches and displays the 4 most 
  recently uploaded images to keep the content fresh.
- Gallery.html: The main viewing area. Includes a real-time search filter to 
  find specific scenes by title, author, or description.
- submit.html: The upload hub. Supports multi-file selection and provides 
  instant image previews before saving to the database.
- auth.html: The secure entry point for Login and Signup.
- About.html: Static page describing the mission and features of the site.
- app.py: The custom threaded HTTP server managing routes, DB connections, and Auth.
- js/script.js: Shared frontend logic for:
    * Communicating with the Python API.
    * Managing the Modal (detail view) system.
    * Persistence logic for the Light/Dark mode toggle via localStorage.
- style.css: A centralized stylesheet using variables to allow instant theme 
  switching and ensuring a responsive layout across all device sizes.

4. KEY FEATURES
---------------
- Secure Authentication: Industry-standard password hashing with bcrypt.
- Aesthetic Theming: A custom-built Dark/Light mode toggle that remembers 
  user preferences.
- Administrative Controls: Dedicated panels for Admins and Moderators to 
  manage the community and content.
- Album Support: Post multiple photos in a single scene with a sleek slider.
- Curated Collections: Organize your favorite scenes into custom-named groups.
- Security Headers: Hardened server with X-Frame-Options and Content Security Policy.
- Port Scanning: Built-in discovery of available ports for easier local hosting.

5. FUTURE SCALABILITY
---------------------
The current custom Python/SQLite architecture is ready for deployment. Future 
improvements include migrating image storage to a cloud provider like 
Cloudinary or AWS S3 to handle massive amounts of high-resolution data.