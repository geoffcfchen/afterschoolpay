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
- `VITE_BOOTSTRAP_OWNER_EMAIL`

The early-access form writes to Firestore collection `earlyAccessLeads`.

`VITE_BOOTSTRAP_OWNER_EMAIL` should be the email address for the first owner.
When that person logs in, the app creates the default Afterschool Pay
organization and gives them Level 1 access. Other new users are saved as
pending members until an owner grants access.

### Authentication

Enable these sign-in providers in Firebase Authentication:

- Email/Password
- Google

For Google sign in, set a support email and confirm these authorized domains:

- `localhost`
- `afterschoolpay.com`
- `www.afterschoolpay.com`
- `afterschoolpay.firebaseapp.com`

The login modal uses the same identifier-first provider detection flow as
Vetcation. For this to work, Firebase must return sign-in methods from
`fetchSignInMethodsForEmail`, so Email enumeration protection must be disabled
in Firebase Authentication settings.

### Firestore Rules

Create or open Firestore Database in Firebase, then publish the rules from
`firestore.rules` in Firebase Console:

```text
Firebase Console > Firestore Database > Rules
```

The starter rules currently bootstrap `gcfchen@gmail.com` as the first owner.
If your owner login email is different, update the email in `firestore.rules`
before publishing the rules.

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
- `VITE_BOOTSTRAP_OWNER_EMAIL`

### Firestore Structure

The first logged-in version uses this expandable organization structure:

```text
users/{uid}
organizations/{orgId}
organizations/{orgId}/members/{uid}
organizations/{orgId}/branches/{branchId}
organizations/{orgId}/programs/{programId}
```

For the initial Afterschool Pay workspace, `orgId` is `afterschoolpay`. More
afterschool businesses can be added later as additional documents under
`organizations`.

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
