# Afterschool Pay

React, Vite, and Firebase web app for `afterschoolpay.com`.

## Local Setup

Install dependencies:

```bash
npm install
```

Create `.env.local` from `.env.example` and add the Firebase web app values.

Run the app locally:

```bash
npm run dev
```

## Firebase

The frontend reads Firebase config from Vite environment variables:

- `VITE_FB_API_KEY`
- `VITE_FB_AUTH_DOMAIN`
- `VITE_FB_PROJECT_ID`
- `VITE_FB_STORAGE_BUCKET`
- `VITE_FB_MESSAGING_SENDER_ID`
- `VITE_FB_APP_ID`
- `VITE_FB_MEASUREMENT_ID`

The early-access form writes to Firestore collection `earlyAccessLeads`.

### Authentication

Enable these sign-in providers in Firebase Authentication:

- Email/Password
- Google

For Google sign in, set a support email and confirm these authorized domains:

- `localhost`
- `afterschoolpay.com`
- `www.afterschoolpay.com`
- `afterschoolpay.firebaseapp.com`

## GitHub Pages Deploy

The workflow at `.github/workflows/deploy.yml` builds and deploys the site when
changes are pushed to `main`.

In GitHub, add these repository secrets:

- `VITE_FB_API_KEY`
- `VITE_FB_AUTH_DOMAIN`
- `VITE_FB_PROJECT_ID`
- `VITE_FB_STORAGE_BUCKET`
- `VITE_FB_MESSAGING_SENDER_ID`
- `VITE_FB_APP_ID`
- `VITE_FB_MEASUREMENT_ID`

Then set GitHub Pages source to GitHub Actions and configure the custom domain:

```text
afterschoolpay.com
```

The `public/CNAME` file keeps the custom domain attached after each deploy.

## Scripts

```bash
npm run dev
npm run build
npm run lint
npm run preview
```
