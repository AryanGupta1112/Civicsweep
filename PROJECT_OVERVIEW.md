# CivicSweep — Full Project Explanation (Simple Language)

This document explains the **CivicSweep app + civicsweep‑api** in clear, simple language. It covers **what we built**, **why we chose each technology**, **how it works**, **how it’s different**, and **how it improves accuracy**.

---

## 1) What This Project Is
CivicSweep is a **mobile waste reporting and resolution system**. It connects three roles in one flow:
- **Citizens** report waste with photo + location.
- **Admins** manage and assign reports to vendors.
- **Vendors** complete tasks and upload proof.

It is not just a reporting app. It is a **full workflow system** from report → assignment → completion → verification.

---

## 2) The Goal (Why We Built It)
Traditional waste complaint systems are slow and unclear. Often:
- Citizens don’t know what happened after reporting.
- Admins must manually track issues across many tools.
- Vendors don’t have clear assignments or proof workflows.

Our goal:
- **Make reporting easy and fast.**
- **Route issues to the right vendor quickly.**
- **Keep everything visible and auditable.**
- **Reduce wrong assignments and manual follow‑ups.**

---

## 3) Where We Are Right Now (Current Status)
- The **Android app** works for users, admins, and vendors.
- The **backend API** is running on Render (private repo).
- Reports can be created, assigned, completed, and verified.
- AI detection is integrated for **auto‑assignment** by waste type.
- Admins still have **manual override** if needed.

---

## 4) The Full Tech Stack (Simple Explanation)

### A) Android App (Container)
**Technology:** Android WebView (Java)
- We use a native Android shell to run the app.
- The UI is built in web technology and displayed inside the app.

**Why this is good:**
- Faster UI updates.
- Easier design iteration.
- Still feels like a real Android app.

---

### B) Frontend UI (Inside WebView)
**Technology:** HTML + CSS + JavaScript
- The main interface is built like a modern web dashboard.

**Add‑ons used:**
- **Tailwind CSS**: fast styling using utility classes.
- **Flowbite**: ready UI components (tabs, cards, modals).
- **Leaflet**: interactive map for location picking.
- **OpenStreetMap / Nominatim**: free map + reverse address lookup.
- **Notyf**: clean notifications/toasts.
- **Remixicon**: icons for UI.

**Why this is good:**
- Quick to build and update.
- Consistent visuals across screens.
- Lightweight and fast to load.

---

### C) Backend API (civicsweep‑api)
**Technology:** Node.js + Express
- Handles login, report creation, assignments, status updates, vendor actions.

**Database Layer:**
- **Prisma ORM**: type‑safe database access and migrations.
- **PostgreSQL**: reliable storage of users, vendors, and reports.

**Why this is good:**
- Fast REST API development.
- Safe data handling.
- Easy migrations when we add features.

---

### D) AI / ML Service
**Technology:** Roboflow Hosted YOLOv8 Model
- We send the report photo to Roboflow.
- Roboflow returns waste type + confidence.

**Why this is good:**
- No GPU infrastructure needed.
- Hosted model is fast and ready.
- Easy to plug into the backend.

---

### E) Hosting & Deployment
**Technology:** Render
- Backend API runs on Render.
- PostgreSQL is managed by Render.

**Why this is good:**
- Simple deployment.
- Easy environment management.
- Reliable uptime for small teams.

---

### F) GitHub Pages (For PPT / Demo Page)
- We host our presentation page using GitHub Pages.

---

## 5) All Services Explained (Simple)

**1. CivicSweep Mobile App**
- The Android app that citizens, admins, and vendors use.
- It is the main interface of the system.

**2. civicsweep‑api (Backend)**
- The “brain” of the system.
- Handles login, report creation, assignment, and updates.

**3. PostgreSQL Database**
- Stores all data (users, vendors, reports, status history).

**4. Roboflow AI Model**
- Detects waste type from photos.
- Helps auto‑assign reports to vendor type.

**5. OpenStreetMap / Nominatim**
- Converts latitude + longitude into a human‑readable address.

**6. Vendor & Admin Workflows**
- Vendors: see assigned tasks and submit proof.
- Admins: see all reports, assign vendors, update status.

---

## 6) How the System Works (Step‑by‑Step)

### Citizen Flow
1. Citizen logs in.
2. Creates a report with title, description, photo, and location.
3. Report is sent to backend and stored in database.

### AI + Auto‑Assignment Flow
1. Backend sends the photo to Roboflow.
2. Roboflow returns waste class + confidence.
3. Backend maps this class to a **vendor type**.
4. The report is auto‑assigned to that vendor.
5. If detection fails, it goes to **general vendor** with an alert note for admin.

### Admin Flow
1. Admin sees all reports (including auto‑assigned ones).
2. Admin can reassign if needed.
3. Admin updates status (new → assigned → resolved).

### Vendor Flow
1. Vendor logs in.
2. Vendor sees assigned tasks.
3. Vendor completes the job and uploads proof.
4. Admin reviews proof and closes the report.

---

## 7) What Makes CivicSweep Different From Traditional Systems
Traditional systems:
- Only collect complaints.
- Require manual assignment and follow‑ups.
- No clear proof or audit trail.

CivicSweep:
- Full pipeline with **clear accountability**.
- **Photo + GPS** for accurate reporting.
- **AI‑based waste type detection** for smarter routing.
- **Proof‑of‑completion** stored with each report.
- **Admin override** keeps control in human hands.

---

## 8) How This Improves Accuracy
- **Photos reduce wrong descriptions.**
- **Location removes guesswork.**
- **AI waste detection reduces wrong assignments.**
- **Vendor type mapping sends tasks to specialists.**
- **Proof upload reduces fake closures.**

---

## 9) Why This Tech Stack Is a Good Fit
- **WebView UI** = fast UI changes without rebuilding full native UI.
- **Tailwind + Flowbite** = fast, consistent design.
- **Node + Express** = fast API development.
- **Prisma + Postgres** = reliable, structured data.
- **Roboflow** = no GPU ops required.
- **Render** = quick deploy, low ops effort.

---

## 10) What We Took From Where (Dependencies & Sources)
- **Roboflow Model**: YOLOv8 trash detection (hosted inference API).
- **Leaflet**: map interface library.
- **OpenStreetMap/Nominatim**: free map and geocoding.
- **Tailwind CSS**: UI styling.
- **Flowbite**: UI components.
- **Notyf**: notification/toast library.
- **Remixicon**: icon library.

---

## 11) Current Limitations (Honest View)
- Auto‑assignment depends on vendor `wasteType` being set correctly.
- AI accuracy depends on photo quality and lighting.
- If migrations aren’t applied, DB errors occur.
- Photos stored in DB as base64 (can be heavy at scale).

---

## 12) Future Improvements (Possible Next Steps)
- Move photos to cloud storage instead of DB.
- Analytics dashboard for admin performance and SLA tracking.
- AI confidence threshold tuning per waste type.
- Better vendor performance scoring.
- Offline report capture (queue for later upload).

---

## 13) Project Structure (Simple Map)
- `app/` → Android container + WebView assets
- `app/src/main/assets/` → HTML/CSS/JS UI
- `civicsweep-api/` → backend API (private repo)
- `prisma/` → DB schema and migrations
- `index.html` → presentation page (GitHub Pages)

---

## 14) Final Summary
CivicSweep is a **full workflow system** for waste reporting and resolution, not just a complaint form. It uses modern UI tools, a robust backend, and AI‑assisted routing to reduce delays and improve accuracy. Admins still retain control, but AI handles the first assignment step to improve speed. The result is a system that is **faster, clearer, more accurate, and more accountable** than traditional complaint apps.
