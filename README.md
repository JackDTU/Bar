# Last Orders — bar menu + MobilePay

## 1. Images (once, on your PC)
    pip install pillow numpy scipy requests
    python tools/prepare_images.py          # optional: set GOOGLE_API_KEY + GOOGLE_CX for drinks without an Ambrosia photo

## 2. Run locally
    npm install
    cp .env.example .env     # fill in keys
    npm start                # http://localhost:3000

## 3. Publish (Render, free tier)
1. Push this folder to a GitHub repo (`.env` is git-ignored).
2. render.com -> New -> Blueprint -> pick the repo (uses render.yaml).
3. Fill CLIENT_ID, CLIENT_SECRET, SUB_KEY, MSN, ADMIN_KEY and PUBLIC_URL (= your https://....onrender.com address).
4. Register the webhook in the Vipps MobilePay portal: PUBLIC_URL/api/webhook
5. Open the URL on your phone. Staff view: PUBLIC_URL/admin.html?key=ADMIN_KEY
Switch VIPPS_BASE to https://api.vipps.no with live keys when you go live.
Render free instances sleep after idle time and the orders file is not persistent: use a paid instance + disk, or a small database, for a real bar.
