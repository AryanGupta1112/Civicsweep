# CivicSweep

CivicSweep is a mobile-first waste reporting and resolution platform that connects citizens, vendors, and city administrators in one workflow. The Android app in this repository provides the full experience inside a fast, modern WebView UI.

## What CivicSweep Does
- Lets citizens submit waste reports with a title, description, location, and photo.
- Shows live report status updates (new, assigned, in progress, resolved).
- Enables administrators to review incoming reports, assign vendors, and track progress.
- Enables vendors to view assigned work and upload completion proof.
- Provides a consistent, role-based dashboard for each user type.

## Who It's For
- Citizens: report issues quickly and track progress.
- Vendors: receive assignments and confirm completion with photo proof.
- Administrators: coordinate vendors, manage status, and audit reports.

## Typical Workflow
1. A citizen creates a report with a photo and location.
2. The report appears in the admin dashboard.
3. An admin assigns a vendor and updates status.
4. The vendor completes the task and uploads proof.
5. The admin reviews the result and closes the report.

## What?s In This Repository
This repo contains the Android client and the UI assets:
- Android app container with a WebView front end.
- Responsive HTML/CSS/JS UI tailored for mobile.
- Map-based report creation and preview.
- Role-based dashboards for users, vendors, and admins.

## Private Backend (civicsweep-api)
The backend API is a separate, private repository hosted on Render. It is responsible for:
- Authentication and role-based access.
- Report creation, status changes, and vendor assignment.
- Image storage for report photos and completion proof.
- Persistent data storage in PostgreSQL.

This private repo is intentionally not included here. The Android app connects to the hosted API service on Render.

## High-Level Architecture
- Android app (this repo) provides the UI and captures data.
- Private API (Render) validates requests and stores data.
- PostgreSQL stores users, vendors, and reports.

## Notes for Stakeholders
- CivicSweep is designed for clear accountability from report to resolution.
- The UI emphasizes speed, clarity, and visibility for all roles.
- The platform can be extended for additional categories or workflows.

## Support
For access, credentials, or onboarding, contact your project administrator.
