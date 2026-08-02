# Revive Cafe Jobs — Deployment Guide

## Step 1: Supabase Setup

1. Go to https://supabase.com → open your **Revive Cafe Jobs** project
2. Go to **SQL Editor** → paste the entire contents of `setup-db.sql` and click **Run**
3. Go to **Authentication → Users → Add User**:
   - Email: `jobs@revivealicious.com`
   - Password: `Blue1234!`
4. Go to **Storage** — confirm these 3 buckets were created: `gallery`, `resumes`, `cover-letters`
   - If not, create them manually (gallery = Public, the others = Private)

## Step 2: Resend Domain Setup

1. Go to https://resend.com → sign in
2. Go to **Domains → Add Domain** → enter `revivealicious.com`
3. Copy the 3 DNS records it gives you
4. Log into wherever revivealicious.com is managed (GoDaddy, Cloudflare, etc.) → DNS settings → add the 3 records
5. Back in Resend, click Verify — usually confirms within 5–30 minutes

## Step 3: Deploy to Netlify

### Option A: Drag & Drop (quickest)
1. Go to https://netlify.com → sign in
2. Go to **Sites → Add new site → Deploy manually**
3. Drag the entire `revivejobs` folder onto the deploy zone
4. After deploy, go to **Site settings → Change site name** → set to `revivejobs`

### Option B: GitHub (recommended for ongoing updates)
1. Create a new GitHub repo and push the `revivejobs` folder contents to it
2. In Netlify → **Add new site → Import from Git** → connect the repo
3. Set publish directory to `/` (root), no build command needed

## Step 4: Add Environment Variables in Netlify

Go to **Netlify → Site settings → Environment variables → Add a variable** for each:

| Variable Name | Value |
|---|---|
| `RESEND_API_KEY` | `(your Resend API key)` |
| `CLAUDE_API_KEY` | `(your Anthropic API key)` |
| `SUPABASE_URL` | `https://zpcbtfdjcsbdeqnizrpr.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | *(your service role key from Supabase → Settings → API)* |

After adding all four variables, go to **Deploys → Trigger deploy → Deploy site**.

## Step 5: Test the Site

Once live at https://revivejobs.netlify.app:

1. **Public site** — open `index.html`: should show jobs page with Revive branding
2. **Admin portal** — open `admin.html` → log in with `jobs@revivealicious.com` / `Blue1234!`
3. **Create a test job** — Admin → Post New Job → fill details → Save & Activate
4. **Test application** — public site → click job → complete the 3-step form → submit
5. **Check email** — confirmation should arrive at the email you used to apply
6. **Test interview flow** — Admin → set applicant to Interview → Send Invite → open link in the email → pick a slot

## Ongoing Usage — Quick Reference

### Posting a Job
Admin → Post New Job → fill in title, type, description → Status: **Active** → Save

### Sharing on Job Sites
Admin → click job tile → **Copy Job Link** → paste to Seek, Facebook etc.

Add `?ref=seek` or `?ref=facebook` to the link to track where applicants come from:
`https://revivejobs.netlify.app/job.html?id=abc123&ref=seek`

### Reviewing Applications
Admin → click job tile → see applicant rows with AI suitability + human-writing scores

### Running Interviews
1. Set promising applicants to **Interview** status
2. Click **Interview Slots** → add available times
3. Click **Send Interview Invites** — candidates get a unique booking link by email
4. They select a time, complete the extended form, and confirm
5. Their booked slot appears in the portal

### Rejections
Set applicants to **Not Suitable** → **Send Rejections** button appears (bulk send, one-click, no re-sends)

### Settings
Admin → Settings:
- **Company Info** — edit story and benefits shown on public site and in all emails
- **Email Templates** — customise all automated email wording
- **Interview & Declarations** — edit the extended form questions and legal declarations
- **Gallery Photos** — upload/remove the 6 hero photos shown on the public page

## Custom Domain (optional)
To use `jobs.revive.co.nz` instead of revivejobs.netlify.app:
1. Netlify → Domain management → Add custom domain → `jobs.revive.co.nz`
2. In your revive.co.nz DNS, add a CNAME:
   - Name: `jobs`
   - Value: `revivejobs.netlify.app`
3. Netlify auto-provisions SSL — done.
