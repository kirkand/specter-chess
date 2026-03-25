# Specter Chess — Deployment Guide

This guide walks you through deploying Specter Chess so anyone on the internet can play it.
You'll use four services:

| Service | Purpose | Cost |
|---|---|---|
| **GitHub** | Hosts your code so Render and Vercel can read it | Free |
| **Turso** | Hosts your database (ELO ratings, game history) | Free |
| **Render** | Runs your Node.js server 24/7 | Free (see note below) |
| **Vercel** | Serves your React frontend | Free |
| **Porkbun** | Your custom domain (e.g. spectrechess.com) | ~$10–$15/year |

> **Render free tier note:** The server spins down after 15 minutes of inactivity and takes ~30–50 seconds to wake up on the first visit of the day. During active play the server stays awake. This is fine for gathering early feedback — upgrade to Render's $7/month plan when you want always-on behavior.

---

## Part 1 — Push Your Code to GitHub

### 1.1 Create a GitHub account
Go to https://github.com and sign up.

### 1.2 Create a new repository
1. Click the **+** in the top-right → **New repository**
2. Name it `specter-chess` (or anything you like)
3. Set visibility to **Public** (required for Vercel free tier)
4. Do **not** initialize with a README (your project already has files)
5. Click **Create repository**

### 1.3 Install Git
If you don't have Git installed, download it from https://git-scm.com and install it.
Accept all defaults during installation.

### 1.4 Push your code
Open a terminal in your `specter_chess` folder and run these commands one at a time:

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/specter-chess.git
git push -u origin main
```

Replace `YOUR_USERNAME` with your actual GitHub username.
GitHub will prompt you to log in — use your GitHub credentials.

---

## Part 2 — Set Up the Database on Turso

Turso is a hosted SQLite service. It stores your ELO ratings and game history in the cloud so data persists across server restarts (unlike a local file).

### 2.1 Create a Turso account
Go to https://turso.tech and sign up (GitHub login works).

### 2.2 Install the Turso CLI

**On macOS / Linux**, open a terminal and run:
```bash
curl -sSfL https://get.tur.so/install.sh | bash
```

**On Windows**, the Turso CLI has no native Windows binary — you need to use WSL (Windows Subsystem for Linux):

1. Open PowerShell **as Administrator** (right-click → Run as administrator) and run:
   ```powershell
   wsl --install
   ```
2. Restart your computer when prompted.
3. After restart, Ubuntu will open automatically to finish setup. Create a Linux username and password when asked (these can be anything).
4. Inside the Ubuntu terminal, install Turso:
   ```bash
   curl -sSfL https://get.tur.so/install.sh | bash
   ```
5. Close and reopen the Ubuntu terminal (so the PATH update takes effect).

> From this point on, run all Turso CLI commands in the **Ubuntu (WSL) terminal**, not in PowerShell.

Then log in:
```bash
turso auth login
```

### 2.3 Create a database
```bash
turso db create specter-chess
```

### 2.4 Get your database URL
```bash
turso db show specter-chess --url
```

Copy the output — it looks like `libsql://specter-chess-yourname.turso.io`.
This is your `TURSO_URL`.

### 2.5 Create an auth token
```bash
turso db tokens create specter-chess
```

Copy the token. This is your `TURSO_AUTH_TOKEN`.

> Keep these two values handy — you'll paste them into Render's environment variables in the next step.

---

## Part 3 — Deploy the Server on Render

### 3.1 Create a Render account
Go to https://render.com and sign up with your GitHub account.

### 3.2 Create a new Web Service
1. Click **New** → **Web Service**
2. Choose **Build and deploy from a Git repository**
3. Connect your GitHub account and select `specter-chess`

### 3.3 Configure the service
On the setup screen:

- **Name:** specter-chess-server (or anything you like)
- **Region:** pick whichever is closest to you
- **Branch:** main
- **Root Directory:** leave blank
- **Runtime:** Node
- **Build Command:** `pnpm install && pnpm --filter @specter-chess/server build`
- **Start Command:** `node packages/server/dist/index.js`
- **Instance Type:** Free

### 3.4 Set environment variables
Still on the setup screen, scroll to **Environment Variables** and add:

| Key | Value |
|---|---|
| `TURSO_URL` | the `libsql://...` URL from step 2.4 |
| `TURSO_AUTH_TOKEN` | the token from step 2.5 |
| `CLIENT_ORIGIN` | *(leave blank for now — fill in after Vercel is set up in Part 4)* |
| `NODE_VERSION` | `22` |

### 3.5 Deploy
Click **Create Web Service**. Render builds and starts your server.
When it finishes (2–3 minutes), you'll see a URL like `specter-chess-server.onrender.com`.
Copy this — you'll need it in Part 4.

---

## Part 4 — Deploy the Frontend on Vercel

### 4.1 Create a Vercel account
Go to https://vercel.com and sign up with your GitHub account.

### 4.2 Import your project
1. Click **Add New** → **Project**
2. Select your `specter-chess` GitHub repository

### 4.3 Configure the build
In the project setup screen:

- **Framework Preset:** Vite
- **Root Directory:** `packages/client`
- **Build Command:** `cd ../.. && pnpm install && pnpm --filter @specter-chess/client build`
- **Output Directory:** `dist`
- **Install Command:** leave blank (handled by build command above)

### 4.4 Set environment variables
Click **Environment Variables** and add:

| Key | Value |
|---|---|
| `VITE_SERVER_URL` | `https://specter-chess-server.onrender.com` *(your Render URL from step 3.5)* |

Make sure you use `https://` (not `http://`).

### 4.5 Deploy
Click **Deploy**. Vercel builds and hosts your React app.
When finished, it gives you a URL like `specter-chess.vercel.app`.

### 4.6 Go back to Render and set CLIENT_ORIGIN
Now that you have your Vercel URL:
1. Go to Render → your Web Service → **Environment**
2. Add or update `CLIENT_ORIGIN` to your Vercel URL, e.g. `https://specter-chess.vercel.app`
3. Click **Save Changes** — Render redeploys automatically

---

## Part 5 — Buy and Connect a Custom Domain (Porkbun)

### 5.1 Buy a domain on Porkbun
1. Go to https://porkbun.com
2. Search for your desired domain (e.g. `specterchess.com`)
3. Purchase it (~$10–$15/year for a `.com`)
4. Create a Porkbun account and complete checkout

### 5.2 Point your domain to Vercel (frontend)
Your main domain (`specterchess.com`) should serve the frontend.

**In Vercel:**
1. Go to your project → **Settings** → **Domains**
2. Click **Add Domain**, type `spectrechess.com`
3. Vercel will show you DNS records to add — copy them

**In Porkbun:**
1. Go to **Account** → **Domain Management** → click your domain
2. Click **DNS** (or **Edit DNS records**)
3. Delete any existing A or CNAME records for `@` and `www`
4. Add the records Vercel gave you. Typically:
   - Type `A`, Host `@`, Answer: Vercel's IP (e.g. `76.76.21.21`)
   - Type `CNAME`, Host `www`, Answer: `cname.vercel-dns.com`
5. Save

DNS changes can take 10–60 minutes to propagate.

### 5.3 Add www redirect in Vercel
In Vercel → **Domains**, also add `www.specterchess.com`.
Vercel will automatically redirect `www` → root (or vice versa).

### 5.4 Update CLIENT_ORIGIN with your real domain
In Render → **Environment**, update `CLIENT_ORIGIN` to `https://specterchess.com`.
Render redeploys automatically.

---

## Part 6 — Verify Everything Works

1. Open `https://specterchess.com` in two browser tabs
2. Tab 1: Create a game
3. Tab 2: Join it
4. Play a few moves — verify hidden-information behavior works
5. Play a full game and confirm ELO ratings update

---

## Quick Reference: Environment Variables

### Render (server)
| Variable | Value |
|---|---|
| `TURSO_URL` | `libsql://specter-chess-yourname.turso.io` |
| `TURSO_AUTH_TOKEN` | your Turso auth token |
| `CLIENT_ORIGIN` | `https://spectrechess.com` |
| `NODE_VERSION` | `22` |
| `PORT` | *(set automatically by Render — do not override)* |

### Vercel (client)
| Variable | Value |
|---|---|
| `VITE_SERVER_URL` | `https://specter-chess-server.onrender.com` *(or your custom server domain if you set one)* |

---

## Local Development

No changes to your local dev workflow. When `TURSO_URL` is not set, the server automatically falls back to a local SQLite file (`local.db` in the server directory). Everything works exactly as before.

---

## Making Future Updates

After the initial deployment, updating the app is simple:

```bash
# In your specter_chess folder:
git add .
git commit -m "Describe what you changed"
git push
```

- **Vercel** detects the push and automatically rebuilds the frontend
- **Render** detects the push and automatically rebuilds and restarts the server

---

## Troubleshooting

**Site loads but just spins for 30–50 seconds on first visit**
- Normal behavior — Render's free tier is waking up from sleep. The first visitor of the day triggers this. After that, it stays awake while there are active connections.

**"WebSocket connection failed" in the browser console**
- `VITE_SERVER_URL` is wrong or missing `https://`
- `CLIENT_ORIGIN` doesn't match the exact frontend URL (including `https://`)
- Make sure both Render and Vercel have redeployed after you changed env vars

**ELO ratings reset / not saving**
- Check Render logs for database errors — the most likely cause is a wrong or missing `TURSO_URL` / `TURSO_AUTH_TOKEN`

**Build fails on Render**
- Make sure `NODE_VERSION` is set to `22`
- Check that `pnpm-lock.yaml` is committed to GitHub (not excluded by `.gitignore`)

**Domain not loading**
- DNS hasn't propagated yet — wait 30–60 minutes and try again
- Use https://dnschecker.org to check if your domain's DNS has updated globally

**Vercel build fails**
- Check build logs — most common cause is missing `pnpm-lock.yaml` in the repo
