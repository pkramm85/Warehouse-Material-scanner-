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

## Data
Saved in each browser's localStorage, so every phone has its own copy and roles are not enforced across devices. Use Export for backups. A shared database with sign-in is the planned next step.
