# Learnit – Full Setup Guide (Client + Server + PostgreSQL)

This guide helps you run the entire Learnit project locally from scratch.

Project parts:

- `learnit.client` → React + Vite frontend
- `Learnit.Server` → ASP.NET Core + EF Core backend API
- PostgreSQL → database used by the backend

---

## 1) Prerequisites

Install these first:

- .NET SDK 9.0+
- Node.js 18+ (LTS recommended)
- PostgreSQL 14+ (or newer)
- Git

Optional but recommended:

- Visual Studio Code with C# and ESLint extensions

Check versions:

```bash
dotnet --version
node --version
npm --version
psql --version
```

---

## 2) Get the source code

```bash
git clone https://github.com/Selva-vignesh-7/Learnit.git
cd Learnit
```

---

## 3) Create PostgreSQL database

You can use pgAdmin or psql. Example with psql:

```sql
CREATE DATABASE learnitdb;
```

Use your own DB user/password and make sure that user has access to `learnitdb`.

---

## 4) Configure backend secrets (recommended: user-secrets)

Go to server folder:

```bash
cd Learnit.Server
```

Set connection string:

```bash
dotnet user-secrets set "ConnectionStrings:Default" "Host=localhost;Port=5432;Database=learnitdb;Username=postgres;Password=YOUR_PASSWORD"
```

Set JWT key (use a strong random string):

```bash
dotnet user-secrets set "Jwt:Key" "YOUR_LONG_RANDOM_SECRET_KEY"
```

Optional AI keys:

```bash
dotnet user-secrets set "Groq:ApiKey" "YOUR_GROQ_API_KEY"
dotnet user-secrets set "OpenAi:ApiKey" "YOUR_OPENAI_API_KEY"
```

Set SMTP settings for reminder emails:

```bash
dotnet user-secrets set "Email:SmtpHost" "smtp.gmail.com"
dotnet user-secrets set "Email:SmtpPort" "587"
dotnet user-secrets set "Email:SmtpUser" "your-email@gmail.com"
dotnet user-secrets set "Email:SmtpPassword" "your-app-password"
dotnet user-secrets set "Email:EnableSsl" "true"
dotnet user-secrets set "Email:FromEmail" "your-email@gmail.com"
dotnet user-secrets set "Email:FromName" "Learnit"
```

Notes:

- If no AI key is configured, AI endpoints return a stub response (this is expected).
- Prefer secrets/env vars over hardcoding values in `appsettings.json`.

---

## 5) Restore server dependencies and run migrations

From `Learnit.Server`:

```bash
dotnet restore
dotnet build
dotnet ef database update
```

If `dotnet ef` is not found:

```bash
dotnet tool install --global dotnet-ef
```

---

## 6) Trust HTTPS development certificate

Run once:

```bash
dotnet dev-certs https --trust
```

This is important because the client runs on HTTPS and proxies API traffic.

---

## 7) Run backend API

From `Learnit.Server`:

```bash
dotnet run
```

Keep this terminal running.

Quick health check (browser):

- `https://localhost:7271/health` (port may vary by environment)

---

## 8) Run frontend

Open a second terminal:

```bash
cd learnit.client
npm install
npm run dev
```

Open:

- `https://localhost:5173`

The Vite dev server proxies `/api/*` requests to the backend.

---

## 9) First-run verification checklist

1. App opens at `https://localhost:5173`
2. Register a new user from `/auth/register`
3. Login works and routes to `/app/*`
4. You can create a course
5. Schedule page loads and can create events
6. Progress page loads without API errors

---

## 10) Common commands

### Backend (`Learnit.Server`)

```bash
dotnet restore
dotnet build
dotnet run
dotnet ef database update
```

### Frontend (`learnit.client`)

```bash
npm install
npm run dev
npm run lint
npm run build
npm run preview
```

---

## 11) Troubleshooting

### Database connection errors

- Verify PostgreSQL is running.
- Re-check `ConnectionStrings:Default` user-secrets value.
- Confirm DB/user permissions.

### 401 Unauthorized on API calls

- JWT config mismatch (`Jwt:Key`, `Jwt:Issuer`, `Jwt:Audience`).
- Clear browser storage and login again.

### CORS / proxy issues

- Ensure backend is running before frontend.
- Confirm frontend runs on `https://localhost:5173`.
- Check CORS origins in `Program.cs` if using custom ports.

### HTTPS certificate problems

- Re-run `dotnet dev-certs https --trust`.
- Restart browser and dev servers.

### AI endpoints not generating rich output

- Add `Groq:ApiKey` or `OpenAi:ApiKey`.
- Without keys, API intentionally returns stub AI responses.

---

## 12) Project architecture (quick view)

- Backend startup and DI: `Learnit.Server/Program.cs`
- EF DbContext and relationships: `Learnit.Server/Data/AppDbContext.cs`
- Main API controllers: `Learnit.Server/Controllers/*`
- Frontend routing: `learnit.client/src/router.jsx`
- Frontend API client: `learnit.client/src/services/http.js`

---

## 13) Production notes

- Do not commit secrets.
- Use environment variables for:
  - `ConnectionStrings__Default`
  - `Jwt__Key`
  - `Groq__ApiKey` / `OpenAi__ApiKey`
- Configure CORS `AllowedOrigins` with your deployed frontend URL.


