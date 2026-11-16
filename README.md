# Warehouse Material Scanner

A phone-friendly web app for scanning materials and tracking warehouse stock. No build step and no dependencies: plain HTML, CSS and JavaScript.

## Features
- **Scan**: camera barcode/QR reading, or type/Bluetooth/USB scanner input. Look up an item, adjust quantity, move location, set a minimum-stock alert.
- **Inventory**: searchable list, CSV export of stock and of the full change history.
- **Receive**: log incoming material against a PO number.
- **Locations**: stock grouped by bin/shelf.

## Run it
From this folder: `python3 -m http.server 8000`, then open `http://localhost:8000`.
The camera needs `localhost` or `https`. To use it on a phone, host the folder on GitHub Pages (Settings > Pages).

## Data
Stored in the browser's localStorage, so each device has its own copy. Use the CSV exports for backup. A shared database is the planned next step.
