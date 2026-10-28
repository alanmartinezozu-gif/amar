# Prospecting: contractor lead lists

Builds a list of contractors to pitch speed-to-lead to. It uses the
[Google Maps Scraper Kit](https://github.com/Mahanaicoach/google-maps-scraper-kit) for the listings,
then checks each contractor's website for what the kit doesn't cover.

| Column | Where it comes from |
|---|---|
| `phone`, `emails`, `website`, `rating`, `reviews` | Google Maps via the kit (emails from the business website) |
| `owner_name`, `owner_source`, `owner_evidence` | The website's schema.org data or "Owner"/"Founder"/"owned and operated by" text on the homepage, about and contact pages; else the Google listing owner when it reads like a person. `owner_evidence` quotes the text it matched so you can check it. |
| `runs_ads`, `ad_signals` | `likely` when ad tracking is installed: Meta Pixel, Google Ads tag (also inside Google Tag Manager containers), Microsoft UET, TikTok/Nextdoor pixels, CallRail or CTM call tracking. `maybe` when a tag container couldn't be read. |
| `has_form`, `form_details` | `yes` for a quote/contact form (Contact Form 7, Gravity Forms, WPForms, Elementor, HubSpot, Jotform...) or a booking widget (Housecall Pro, Jobber, ServiceTitan, GoHighLevel, Calendly). Search boxes, logins and newsletter signups don't count. `unknown` on Wix/GoDaddy sites, whose forms only render in a browser. |

The sheet is sorted with the best prospects first: ads likely and a web form, then by review count.

**`runs_ads = likely` is not proof of a live campaign.** It means they have the tracking that paid
ads use. Before you pitch, check the [Meta Ad Library](https://www.facebook.com/ads/library/) or the
[Google Ads Transparency Center](https://adstransparency.google.com/).

## Run it

1. Start the kit's engine (needs Docker):

   ```bash
   git clone https://github.com/Mahanaicoach/google-maps-scraper-kit.git ~/google-maps-scraper-kit
   cd ~/google-maps-scraper-kit && docker compose up -d
   ```

2. Run the Wyoming list: 23 towns x 7 trades, one job at a time.

   ```bash
   python3 prospecting/wyoming.py --kit ~/google-maps-scraper-kit
   ```

   It writes `prospecting/out/wyoming_contractors.csv`. That folder is git-ignored because it holds
   personal data. If Google rate-limits you midway, run the same command again later and finished
   towns are skipped. `--cities Casper,Cheyenne` and `--trades "roofing contractor,plumber"` narrow a run;
   `--skip-scrape` only re-does the merge and website checks.

3. Any other kit CSV (scraped with `--full`) can be enriched on its own:

   ```bash
   python3 prospecting/enrich.py results.csv leads.csv
   ```

Tests (offline, standard library): `python3 -m unittest discover -s prospecting`

## Before you reach out

Scraping Google Maps is against Google's Terms of Service; keep volume modest and don't resell the
data. Cold email must follow CAN-SPAM (who you are, a real address, a working opt-out). Calls and
texts to cell phones fall under the TCPA, and the FCC treats AI-generated voices as "artificial
voice", so don't put these numbers through this repo's AI dialer without prior express consent.
