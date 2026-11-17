# Launch plan

Researched 2026-10-25 by one Sonnet agent (capped at 10 web lookups; "unverified" means not checked).

Launch with Model A (pay once, free tier plus $12.99 Pro), sold direct, aimed first at Windows customization and PC-gaming-tool audiences with short "pill morphs while I game / play music" videos. Every comparable that worked (Wallpaper Engine ~$4, Lossless Scaling $6.99, NotchNook $15-25 lifetime, Bongo Cat free+DLC) was one-time or free-with-add-ons, and teens rarely hold subscriptions. Before charging, fix the three blockers: code signing (SmartScreen), a public download host (repo is private so updater and release links 404), and a French version of the site (Quebec law).

## Pricing fit
- **Model A:** Pay once ($12.99 Pro, $7.99 student, free tier, optional $2.99 cosmetic packs, direct via Polar, Steam later). Launch is simple: one price in the video call to action, one-time checkout, gift link for parents, no churn or renewal emails to run. It matches what worked for comparables (Wallpaper Engine $4.99, Lossless Scaling $6.99, NotchNook $15-25 lifetime, Bongo Cat free plus cosmetic DLC). Risk: phone link and Land anywhere rely on third-party relays, so 'lifetime' needs careful wording (NotchNook reviewers complained about what 'lifetime' means). Also Polar as merchant of record and Steam as second channel are in the design but I did not verify Polar's terms in this research.
- **Model B:** Subscription ($24/year, $2.99/month, $12/year student, $59 lifetime side option, Microsoft Store + Paddle). It fits ongoing relay and sync costs, but needs the Store listing, Paddle account, trial handling, renewals and cancellation support, and there are more moving parts for a solo CEGEP student. Many Windows customization users resist subscriptions for a desktop widget (my judgment, unverified), and a subscription for teens who mostly lack their own cards is harder. The Store route removes the SmartScreen warning, which is a real plus, but I did not verify the Store's fees, review timing or age rules.
- **Easier to launch:** Model A. One-time payment is easier to explain in a 15-second video, matches the price expectations in this niche, and has far less setup. If Moss later wants the Store's no-SmartScreen benefit, add the Store as an extra channel, not a different pricing model.

## Timeline
**Before launch**
- Unblock distribution: make the download host public (a separate public releases repo or site) so the updater and links work; the private repo makes release links 404 and the updater fails.
- Code-sign the exe (SmartScreen) or at minimum explain 'More info, Run anyway' on the site; same for Mac 'Open Anyway'.
- Check free-service terms for a paid product: Open-Meteo (their free API is non-commercial; unverified, check for a commercial plan), n0 public iroh relays (best-effort, consider dedicated relay or note risk), ntfy.sh, Vercel Hobby (Hobby plan is non-commercial per Vercel's terms; unverified, move to Pro if the phone web app is part of a paid product), Hugging Face model terms.
- Build the site: hero clip, features, pricing, FAQ, privacy and terms, with a French version.
- Record a bank of 10-15 short clips; set up Polar (or chosen seller) test purchase and license key check.
- Warm up a Reddit account by commenting for 2-4 weeks (suggested by a guide I found); pick a distinct product name or suffix to avoid clashing with Island (island.io).
- Send free keys to 5-10 customization/tech creators and ask for early feedback from a few testers outside Moss's PC (so far only Moss uses Island).

**Launch week**
- Day 1: Show HN and Product Hunt (if the download works for anyone) plus one Reddit post in the best-fit community.
- Day 1-3: post a video a day on TikTok/Shorts/Reels, reply to every comment for the first hours.
- Day 2-4: one post each in 2-3 other communities (spaced out, reading each rule first).
- Send creator emails; ask round-up sites to add Island.
- Watch the SmartScreen and crash reports; ship a fix release fast.

**First 30 days**
- Post 3-5 videos a week and repeat whichever hook gets the most views.
- Collect bug reports; ship weekly releases and mention them in posts.
- Add to round-up lists; start the SEO page.
- Run the launch offer (Model A: 14 days or 500 buyers) and then close it on time.
- Review refund rate and which Pro feature people mention; decide on Steam as a second channel and a back-to-school promo.
- Plan Mac notarization and English-plus-French translation of the app UI.

## Channels, best first
| # | Channel | Tactic | Self-promo rules | Cost | Hours/week |
|---|---|---|---|---|---|
| 1 | Short video (TikTok, YouTube Shorts, Instagram Reels) | Post 3-5 screen-recorded clips a week built on the 'pill morphs' visual; same clip on all three platforms; link in bio to the site. Tag with Windows customization, desk setup and PC gaming hashtags (e.g. #windows11, #desksetup, #pcsetup; check each tag's size before use, unverified). | No self-promo rules for own account; do not use paid ads aimed at under-18s (Google bans personalized ads under 18; Meta teen targeting is restricted). Organic is fine. | $0 | 5 |
| 2 | Reddit (Windows customization, desk setup, PC and Claude communities) | Post a clip or screenshot with an honest 'I made this' title, answer comments for hours, one subreddit at a time, spaced out. Warm up the account first by commenting. | Unverified per subreddit; I could not retrieve any specific subreddit's rules. Reddit-wide: accounts that mostly post links to their own product are treated as spam; many subs require approval, flair or account age/karma. Read each sidebar and message mods first. | $0 | 3 |
| 3 | Product Hunt + Hacker News Show HN launch day | One Product Hunt launch (NotchNook used one) and a Show HN framed around Tauri/Rust, 15 MB, and iroh E2E encryption. Needs a working public download first. | Show HN: link must be something people can try without signup; no asking for upvotes. Product Hunt: no vote-begging (rules not re-verified in this research). | $0 | 4 |
| 4 | Outreach to Windows-customization YouTubers and tech writers | Send a short personal email with a free Pro key and a 20-second clip; target channels that already review DynamicWin-style apps and Rainmeter setups (The Tech Styler is one example found). Also pitch round-up sites that list 'Dynamic Island for Windows' apps (notchpixel.com and notchy.dev both publish such lists, so ask to be added). | Disclose free keys. Do not demand coverage. | $0 plus free keys | 3 |
| 5 | Own website SEO page 'Dynamic Island for Windows' | One page with GIFs, comparison to DynamicWin and others, and the download; searches for 'Dynamic Island for Windows' already surface comparison guides, so rank there. Must have a French version (Quebec law). | Quebec: site aimed at Quebec customers must offer a complete French version (see checks). | Domain about $15/year; French translation time | 2 |
| 6 | Steam listing (second channel, later) | A free Steam app with Pro as DLC, like Bongo Cat's free-plus-add-ons model, to reach gamers who live in Steam and pay with Steam Wallet. | Steam Direct fee and review process (fee amount unverified); Steam rules on DLC and external keys apply. | Steam Direct fee (unverified, about $100 per app) | 2 |

## Who and where
| Group | Where online | Hook | Pitch |
|---|---|---|---|
| PC gamers | r/pcgaming (unverified rules), r/pcmasterrace (unverified rules), r/Steam (unverified), YouTube/TikTok PC setup and FPS-tweak videos, Steam discussions and Discord servers of overlay/FPS tools | Live FPS and ping in the pill, even at smallest size, plus music bars | A tiny pill at the top of your screen shows FPS and ping while you play, and turns into a music player when you stop. |
| Tech people / power users | r/Windows11 (rules unverified), r/Windows10 (unverified), r/windowsapps (unverified), Hacker News Show HN, Product Hunt, Lobsters / dev.to | Tauri 2 (Rust) 15 MB single exe, no installer, no Electron, self-updating; Peek behind with Ctrl | Dynamic Island and iOS Control Center for Windows in one 15 MB exe, built with Rust and Tauri, not Electron. |
| Clean/minimal desktop and desk-setup people | r/desksetup (unverified rules), r/Rainmeter (unverified), r/WindowsCustomization or r/Windows11 ricing threads (unverified names), YouTube 'Windows 11 rice' / Rainmeter showcase videos, TikTok/Instagram desk-setup tours | Spring-animated pill on any screen edge, Control Center tiles, themes | Make your Windows desktop look like an iPhone: one clean pill instead of a cluttered taskbar and widgets. |
| iPhone owners on Windows | r/iphone (unverified), r/ios (unverified), r/Windows11, YouTube 'iPhone + Windows' videos | Island on your phone: live island, send photos/files/links to PC, copy PC clipboard, lock PC; Land as AirDrop for PCs and Macs | AirDrop and a Dynamic Island for your Windows PC: send a photo from your iPhone to your PC in two taps, even on school Wi-Fi. |
| Students (CEGEP/college/university) | r/college (unverified), r/Cegep and r/Quebec or r/montreal (unverified names), Discord study servers, TikTok #studytok / #studywithme | Reminders ('submit the lab at 3pm'), timers, calendar, Land that works on school Wi-Fi, Workspaces per class | Remind yourself to submit the lab, run a study timer, and move files between school and home PCs, all from one pill. |
| Claude Code / AI coders | r/ClaudeAI (unverified rules), r/ClaudeCode (unverified), X/Twitter dev community, Hacker News, YouTube AI-coding channels | Allow/Deny permission requests, answer Claude's questions and see usage limits from the pill | Approve Claude Code permission prompts from a pill without switching windows, and see every session and your usage limits. |

## Short-video ideas
| First 2 seconds | Shows | Platform |
|---|---|---|
| Hover the pill: it grows into a music player mid-game | First 2 seconds: a game running full screen, FPS and ping already ticking in the tiny pill; then a song change makes it morph. |  |
| AirDrop for Windows: photo from iPhone to PC | First 2 seconds: take a photo on the iPhone and tap send, then the file lands on the PC desktop with the pill animating. |  |
| Your phone's Dynamic Island, on your PC, from cellular | First 2 seconds: split screen with the phone on 5G showing the live island, and the PC pill reacting as a timer starts. |  |
| Approve Claude Code without alt-tabbing | First 2 seconds: a Claude Code permission request appears in the pill while you edit in another window; tap Allow. |  |
| I turned my Windows desktop into an iPhone | First 2 seconds: ugly cluttered taskbar, hard cut to the clean pill and Control Center grid opening with spring animation. |  |
| Tap Ctrl to see through the pill (Peek behind) | First 2 seconds: the pill covers part of a game or doc, tap Ctrl and it turns see-through; a satisfying single-gesture demo. |  |

## Creators to contact
| Name | Platform | Audience |
|---|---|---|
| [The Tech Styler](https://www.youtube.com/@TheTechStyler) | YouTube | Windows 11 customization: Start menu, taskbar, desktop, icons, themes, Rainmeter, Windhawk (per search description; subscriber count unverified) |

## Checks before launch
| Check | Finding | What to do | Source |
|---|---|---|---|
| Is the name 'Island' safe and findable? | Island (island.io, Dallas with R&D in Tel Aviv, CEO Mike Fey) makes the Island Enterprise Browser, backed by Sequoia, Insight, Cisco, Coatue and others, and is listed on the App Store and AWS Marketplace. The bare name 'Island' will be hard to search for and may carry trademark risk if marketed as a browser/software product; the search found no direct dispute with a Windows app. Trademark conflict analysis is unverified; a lawyer or a trademark search (CIPO/USPTO) is needed. | Use a distinctive product name or domain, for example 'Island for Windows' with a unique brand word, and always say 'Dynamic Island for Windows' in SEO copy; run a trademark search before paying for a logo, domain or Steam page. Also avoid implying Apple affiliation (Apple's 'Dynamic Island' name is Apple's term; unverified trademark status). | [link](https://www.businesswire.com/news/home/20221110005269/en/Island-Extends-Its-Series-B-with-an-Additional-60M-Investment) |
| Ad-targeting limits for users under 18 | Google: no personalized ads for under-18s (no interest, remarketing, custom or lookalike audiences); only contextual targeting, and no campaign aimed solely at under-18s. Meta: teen targeting has been cut to basics (age and location per TechCrunch; a 2026 guide says custom and lookalike audiences are blocked too, not verified against Meta's docs). TikTok rules not checked. | Do not rely on paid ads to reach 13-17s; use organic video, Reddit, creators and search. Show no ads inside the app. Check TikTok's policy separately before any spend. | [link](https://www.carnegiehighered.com/what-can-you-do-google-ad-under-18-restrictions/) |
| Quebec French-language rule for ads and the website | Websites, social media and ads aimed at Quebec customers must be available in French, with the French version complete and offered on terms at least as favourable as any other language (equivalence for websites; 'markedly predominant' French for public signs and ads). Software can stay in another language only if no French version exists anywhere; if one exists it must be offered on equal terms. Sellers outside Quebec who sell to Quebec consumers online still need French, and the OQLF has begun fining English-only web pages (sources are mostly law-firm blogs; exact scope for a solo developer is a lawyer question). | Publish a French version of the site, pricing page, checkout text and terms before launch; plan French UI for the app (it is English only today); put French next to English on any Quebec-facing posters or ads; confirm scope with the OQLF or a lawyer. | [link](https://www.smartbiggar.ca/insights/publication/quebecs-french-language-requirements-for-commerce-and-business-reform-of-the-charter-of-the-french-language) |

## How similar apps launched
| Product | What worked | Numbers | Source |
|---|---|---|---|
| Wallpaper Engine (Windows, Steam) | Solo-started by Kristjan Skutta; launched on Steam as paid early access in Oct 2016 at about $4, stayed in early access about 2 years (full release Nov 2018), bootstrapped. Steam Workshop (users make and share wallpapers) created a content loop; later boosted by Steam China (announced Aug 2019). Lesson: very cheap one-time price plus a visual product that sells itself in screenshots plus user-made content. | Reached Steam top-10 by concurrent users (~77k per mein-mmo.de, driven largely by China); Steam reviews 850k+ (Baidu Baike, Mar 2025). Price now $4.99. | [link](https://en.wikipedia.org/wiki/Wallpaper_Engine) |
| Lossless Scaling (Windows, Steam) | One developer (label THS), released 28 Dec 2018 as a niche pixel-game integer scaler, then added upscalers and frame generation that gamers talk about constantly. Cheap one-time price ($6.99) and heavy Steam-sale discounting. Lesson: a gamer utility with a clear 'more FPS' promise spreads by word of mouth in gaming communities. | Third-party estimates only: 2-5M owners, ~17k-33k reviews (sources disagree), peak ~21k concurrent, est. gross ~$7.5M (unverified estimate). | [link](https://steamspy.com/app/993090) |
| Bongo Cat (Windows desktop companion, Steam) | Free Steam app released 5 Mar 2025 by Marcel Zurawka and Julius Krueger (Irox Games); money from optional cosmetic DLC and tradable hats. Streamers and friends running it on screen made it viral; later added a co-op update (up to 100 cats). Lesson: free plus cosmetic add-ons works for a cute always-on-screen desktop widget, but it leans on Steam's reach. | All-time peak 194,508 concurrent (May 2025); about half of earlier counts were bots per the dev (Eurogamer via search summary); 97% positive across 108k reviews. | [link](https://www.pcgamer.com/games/life-sim/bongo-cat-still-one-of-the-biggest-games-on-steam-gets-even-bigger-with-multiplayer-you-can-now-have-up-to-100-cats-on-your-screen-at-once-all-of-them-happily-bapping-away-as-their-owners-type/) |
| NotchNook (Mac notch app, lo.cafe) | Released July 2024 with a one-time lifetime license ($25 originally, or $3/month; now listed $15 lifetime or $2/month) plus a trial; got press (Macworld) and a Product Hunt relaunch. Closest analog to Island's concept. Caution: in Sept 2026 it went offline during an ownership dispute, and reviewers distrust 'lifetime' promises. Lesson: lifetime pricing sells, but be explicit about what lifetime covers. | Company claims 60,000+ Mac buyers (own claim, unverified). Product Hunt relaunch page showed it ranked #4 for the day. | [link](https://www.producthunt.com/products/notchnook) |
| DynamicWin (Windows Dynamic Island, free) | The best-known free Windows competitor: GitHub-hosted releases, spring-animated notch, media player, file tray, calendar, auto-updater; 600+ stars per one guide. It is free, last updated 22 Oct 2025 (v2.0.3), and its repo has releases only (no source). Lesson: the Windows niche has free, thinly-maintained rivals, so Island must win on polish and on features they lack (phone, Land, Claude Code, games). | 600+ GitHub stars (single-source claim). No sales or launch data found. | [link](https://github.com/FlorianButz/DynamicWin) |

## Sources
- [Wallpaper Engine - Wikipedia](https://en.wikipedia.org/wiki/Wallpaper_Engine)
- [Why the German Wallpaper Engine for 4 EUR is one of the 10 biggest games on Steam (mein-mmo)](https://mein-mmo.de/en/why-the-german-wallpaper-engine-for-4-e-is-one-of-the-10-biggest-games-on-steam,857028/)
- [Lossless Scaling - SteamSpy](https://steamspy.com/app/993090)
- [Lossless Scaling on Steam](https://store.steampowered.com/app/993090/Lossless_Scaling/)
- [Bongo Cat multiplayer (PC Gamer)](https://www.pcgamer.com/games/life-sim/bongo-cat-still-one-of-the-biggest-games-on-steam-gets-even-bigger-with-multiplayer-you-can-now-have-up-to-100-cats-on-your-screen-at-once-all-of-them-happily-bapping-away-as-their-owners-type/)
- [NotchNook on Product Hunt](https://www.producthunt.com/products/notchnook)
- [DynamicWin on GitHub](https://github.com/FlorianButz/DynamicWin)
- [Dynamic Island for Windows 11 and 10: 9 apps (notchpixel)](https://notchpixel.com/guides/dynamic-island-for-windows)
- [Dynamic Island for Windows? What Exists in 2026 (notchy.dev)](https://notchy.dev/dynamic-island-windows/)
- [Quebec French language requirements (Smart & Biggar)](https://www.smartbiggar.ca/insights/publication/quebecs-french-language-requirements-for-commerce-and-business-reform-of-the-charter-of-the-french-language)
- [Google Ads under 18 restrictions (Carnegie Higher Ed)](https://www.carnegiehighered.com/what-can-you-do-google-ad-under-18-restrictions/)
- [Meta teen ad targeting 2026 (AuditSocials)](https://www.auditsocials.com/blog/meta-teen-ad-targeting-restrictions-parental-controls-2026-age-gated-campaigns)
- [Island Series B extension (BusinessWire)](https://www.businesswire.com/news/home/20221110005269/en/Island-Extends-Its-Series-B-with-an-Additional-60M-Investment)
- [The Tech Styler (YouTube)](https://www.youtube.com/@TheTechStyler)
