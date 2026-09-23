# UFicon Dify Deployment Stack

Production Docker Compose stack for deploying **Dify AI RAG** on **Coolify** (PVE).

---

## 🏗️ Architecture

```
Internet (HTTPS :443)
       │
       ▼
Coolify Traefik Proxy (SSL Termination)
       │
       ▼ (Port 80)
   nginx:alpine (Internal Reverse Proxy)
       ├── /console/api, /api, /v1, /files ──> api:5001 (Flask API)
       └── / (and /install)               ──> web:3000 (Next.js UI)
                                                 │
       ├── worker (Celery background tasks) ─────┘
       ├── weaviate:1.39.2 (Vector Database)
       ├── PostgreSQL (External PVE Dedicated: 192.168.1.46)
       └── Redis DB 1 (External: 192.168.1.45)
```

---

## 🚀 How to Deploy on Coolify

1. **Create New Resource in Coolify**:
   * Click **+ New Resource**
   * Select **Git Repository (Private / Public)**
   * Repository: `allday9z/uficon-dify`
   * Branch: `main`
   * Build Pack: **Docker Compose**
   * Base Directory: `/`

2. **Configure Domain in Coolify UI**:
   * Go to **Services** tab in Coolify:
     * Click on **`nginx`**: Set Domain to `https://dify.coolify.pve01.prod.uficon.com` (Port `80`).
     * Click on **`api`**, **`web`**, **`worker`**, **`weaviate`**: Ensure Domains field is **EMPTY**.

3. **Configure Environment Variables in Coolify UI**:
   Copy from `.env.example` and fill in your passwords:
   * `SECRET_KEY`
   * `DB_USERNAME`, `DB_PASSWORD`, `DB_HOST`, `DB_PORT`, `DB_DATABASE`
   * `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`, `REDIS_DB`
   * `CELERY_BROKER_URL`, `CELERY_BACKEND`

4. **Deploy**:
   * Click **Deploy**
   * Once running, open `https://dify.coolify.pve01.prod.uficon.com/install` to create the initial Admin account.
