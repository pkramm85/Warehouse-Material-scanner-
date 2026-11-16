# Material Scanner (Carr & Duff)

A phone-friendly web app for checking material in and out, tracking stock, and running cycle counts. Plain HTML, CSS and JavaScript: no build step, no installs.

## Tabs
- **Scan**: Check in / Check out, camera or typed code, quantity, job, note. Undo for 15 minutes. Low-stock list and recent scans.
- **Stock**: on-hand list, low/out tiles, search. Admins can add, edit, correct counts, delete, export and import a CSV.
- **History**: every scan, searchable and filterable, with CSV export.
- **Counts**: blind cycle counts with admin approval of differences.
- **Team**: admins. The first person to set up the app is an admin.
- **Help**: in-app instructions.

## Run locally
`python3 -m http.server 8000`, then open `http://localhost:8000`. The camera needs https or localhost (GitHub Pages is https).

## Camera
Uses the browser's built-in BarcodeDetector where available (Chrome on Android). Everywhere else, including iPhone, it loads the ZXing library on demand.

## Sign-in, roles and shared data
Data lives in a shared Supabase database, so every phone sees the same stock. People sign in with their @carrduff.com email. New accounts start with no access until an admin approves them and picks a role:

| Role | Can do |
|---|---|
| Warehouse | Scan in/out, see stock and history, undo own scan for 15 minutes, count |
| Manager | Also add/edit/delete materials, correct counts, approve counts, import/export, undo any scan |
| Admin | Also approve people and change roles |

The rules are enforced by the database (`supabase/schema.sql`), not by the app, so they can't be bypassed from a phone. Setup steps are in `supabase/SETUP.md`. `config.js` holds the public project URL and anon key. Never put a service_role key in the repo.
