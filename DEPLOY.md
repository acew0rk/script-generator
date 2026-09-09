# Putting this online (free, permanent, password-protected)

You'll do this once. It gives you a URL like `https://mcat-script-generator.onrender.com`
that anyone with the password can use. Nothing costs money.

There are two accounts to make: **GitHub** (stores the code) and **Render** (runs it).

---

## Part 1 — Put the code on GitHub

1. Make a free account at <https://github.com/signup>.
2. Go to <https://github.com/new> and create a repository:
   - **Repository name:** `mcat-script-generator`
   - Leave it **Public** or **Private** (either works).
   - Do **not** tick "Add a README".
   - Click **Create repository**.
3. GitHub now shows a page with commands. Ignore them — tell Claude
   "the repo is created, the URL is `https://github.com/<you>/mcat-script-generator`"
   and Claude will push the code for you. (Claude will ask you to create a one-time
   access token so the push can authenticate.)

> If you'd rather not use a token: on the empty repo page click
> **uploading an existing file**, then drag in every file and the `public` folder
> from `/Users/ace/Documents/Projects/Random Play/` **except** `.env`. Commit.

---

## Part 2 — Run it on Render

1. Make a free account at <https://render.com> — click **Sign up** and choose
   **GitHub**, so Render can see your repo.
2. In the Render dashboard click **New +** → **Blueprint**.
3. Pick the `mcat-script-generator` repo. Render reads `render.yaml` and shows the
   service it will create.
4. It will ask you to fill in the two secret values:
   - **GEMINI_API_KEY** — paste your Gemini key (from <https://aistudio.google.com/apikey>)
   - **APP_PASSWORD** — make up a password. This is what you give to people who
     should be allowed to use the site.
5. Click **Apply** / **Create**. First build takes 2–4 minutes.
6. When it says **Live**, click the URL at the top. Your browser will pop up a
   login box: leave the username blank (or type anything) and enter the password.

Done. Share the URL **and** the password with whoever you want.

---

## Notes

- **Free tier sleeps.** After ~15 minutes with no visitors the site goes to sleep;
  the next visit takes ~30–60 seconds to wake, then it's fast again.
- **Everyone shares your one Gemini key** and its daily free limit. The password
  keeps it to people you choose. If someone abuses it, change `APP_PASSWORD` in
  Render → Environment, and/or delete the Gemini key and make a new one.
- **Changing the app later:** edit the files, push to GitHub again (Claude can do
  this), and Render redeploys automatically.
- **History** is still per-person and stored in each visitor's own browser.
