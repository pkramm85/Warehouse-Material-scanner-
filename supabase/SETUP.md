# Supabase setup (about 10 minutes)

This gives the app one shared database and real sign-in, so roles are enforced by the server and not just the app.

## Roles
| Role | Can do |
|---|---|
| **Admin** | Everything, plus approve new people and change roles |
| **Manager** | Add/edit/delete materials, correct counts, start and approve cycle counts, import/export, undo any scan |
| **Warehouse** | Scan in/out, see stock and history, undo own scan for 15 minutes, do blind counts |
| **Pending** | A new sign-up. Sees nothing until an admin approves them |

## Locations
Stock, history, counts and low-stock minimums are kept per location. The material list (SKUs) is shared. Admins see every location; everyone else only the locations an admin assigns them (Team tab). Anyone can transfer material from a location they work in to any active location. **2100 Byberry** is created automatically; add more on the Team tab.

Only `@carrduff.com` emails can sign up. `pkramm@carrduff.com` becomes the first admin automatically (change this in `schema.sql` if needed).

## Steps
1. Go to supabase.com, sign up, and choose **New project**. Name it `carr-duff-scanner`, set a database password (save it), pick a US region.
2. Open **SQL Editor > New query**, paste all of `supabase/schema.sql`, press **Run**. You should see "Success".
   - **Already ran the first version?** Run `supabase/002_locations.sql` instead. It keeps people and roles but clears test materials, scans and counts, so only use it before real data is loaded.
3. Open **Authentication > URL Configuration**. Set **Site URL** to the app's Pages link and add the same link under **Redirect URLs**.
4. Open **Project Settings > API**. Copy the **Project URL** and the **anon public** key.
5. Give those two values to Claude. The anon key is designed to be public, since the database rules protect the data. Never share the **service_role** key with anyone.

## Adding people
- They open the app and sign up with their work email, then confirm the email.
- You approve them under **Team**, pick their role, and tap their locations line to choose where they can work.
- Supabase's built-in email is limited to a few messages per hour. For a big rollout, create users under **Authentication > Users > Add user** with "Auto confirm" ticked, or set up a custom email sender later.
