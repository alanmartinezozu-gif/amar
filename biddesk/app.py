"""Bid Desk dashboard.  Run with:  streamlit run app.py   (opens http://localhost:8501)"""
from __future__ import annotations

import hmac
import json
from pathlib import Path

import streamlit as st
import yaml

from biddesk import ai, briefs, db, ingest, match, reports, settings

st.set_page_config(page_title="Bid Desk", layout="wide")


# --- password ----------------------------------------------------------------
def gate() -> None:
    pw = settings.env("DASHBOARD_PASSWORD")
    if not pw:
        st.error("Set DASHBOARD_PASSWORD in .env, then restart the dashboard.")
        st.stop()
    if st.session_state.get("authed"):
        return
    st.title("Bid Desk")
    entered = st.text_input("Password", type="password")
    if entered:
        if hmac.compare_digest(entered, pw):
            st.session_state["authed"] = True
            st.rerun()
        st.error("Wrong password.")
    st.stop()


gate()
conn = db.connect()
ingest.sync_sources(conn)
match.sync_clients(conn)
db.refresh_statuses(conn)

PAGES = ["Inbox", "Opportunity", "Upload a bid", "Clients", "Matches", "Outbox", "Sources health", "AI cost"]
if "page" not in st.session_state:
    st.session_state["page"] = "Inbox"
page = st.sidebar.radio("Bid Desk", PAGES, key="page")
alerts = conn.execute("SELECT COUNT(*) c FROM sources WHERE alert IS NOT NULL").fetchone()["c"]
if alerts:
    st.sidebar.warning(f"{alerts} source alert(s). See Sources health.")
if not ai.available():
    st.sidebar.info("ANTHROPIC_API_KEY is not set, so triage and briefs are off.")


def clients():
    # dicts, not sqlite Rows: Streamlit has to copy selectbox options
    return [dict(r) for r in conn.execute("SELECT * FROM clients WHERE active=1 ORDER BY name").fetchall()]


def open_opportunity(oid: int) -> None:
    st.session_state["opp_id"] = oid
    st.session_state["page"] = "Opportunity"


# --- Inbox -------------------------------------------------------------------
if page == "Inbox":
    st.title("Inbox")
    c1, c2 = st.columns(2)
    status = c1.selectbox("Status", ["open", "closed", "all"])
    only_construction = c2.checkbox("Hide items triaged as not construction", value=True)
    q = ("SELECT o.*, s.name source FROM opportunities o LEFT JOIN sources s ON s.id=o.source_id"
         + ("" if status == "all" else " WHERE o.status=?") + " ORDER BY o.created_at DESC, o.id DESC LIMIT 300")
    rows = conn.execute(q, () if status == "all" else (status,)).fetchall()
    if only_construction:
        rows = [r for r in rows if r["is_construction"] != 0]
    st.caption(f"{len(rows)} opportunities")
    for r in rows:
        with st.container(border=True):
            a, b = st.columns([5, 1])
            tags = ", ".join(json.loads(r["trade_tags"] or "[]")) or ("not triaged" if r["is_construction"] is None else "")
            a.markdown(f"**{r['title']}**  \n{r['owner_name'] or ''} · {r['source'] or ''}  \n"
                       f"Due: {r['due_datetime'] or 'unknown'} · Posted: {r['posted_date'] or 'unknown'} · {tags}")
            b.button("Open", key=f"open{r['id']}", on_click=open_opportunity, args=(r["id"],))

# --- Opportunity detail ------------------------------------------------------
elif page == "Opportunity":
    oid = st.session_state.get("opp_id")
    opp = conn.execute("SELECT * FROM opportunities WHERE id=?", (oid,)).fetchone() if oid else None
    if opp is None:
        st.info("Pick an opportunity from the Inbox.")
        st.stop()
    st.title(opp["title"])
    st.write(f"**Owner:** {opp['owner_name'] or 'unknown'} · **Status:** {opp['status']} · "
             f"**Due:** {opp['due_datetime'] or 'unknown'} · **Pre-bid:** {opp['prebid_datetime'] or 'unknown'}"
             + (" (mandatory)" if opp["prebid_mandatory"] else ""))
    if opp["url"]:
        st.write(f"[Official posting]({opp['url']})")
    with st.expander("Notice text"):
        st.text(opp["raw_text"] or "")

    st.subheader("Documents")
    docs = conn.execute("SELECT * FROM documents WHERE opportunity_id=? ORDER BY id", (oid,)).fetchall()
    for d in docs:
        state = (f"{d['page_count']} pages" + (", scanned (read as images)" if d["needs_vision"] else "")) if d["sha256"] \
            else (d["fetch_error"] or "").replace("pending|", "not downloaded yet: ")
        st.write(f"- **{d['filename']}** ({d['doc_type'] or 'unknown'}) · {state} · first seen {d['first_seen']}")
    up = st.file_uploader("Add documents (PDF)", accept_multiple_files=True, key=f"up{oid}")
    if up and st.button("Save documents"):
        for f in up:
            ingest.store_document(conn, oid, f.name, f.getvalue(), f"upload:{f.name}")
        st.rerun()

    st.subheader("Bid brief")
    cl = clients()
    if not cl:
        st.info("Add a client profile first.")
        st.stop()
    c = st.selectbox("Client", cl, format_func=lambda r: r["name"])
    a = briefs.latest_brief(conn, oid, c["id"])
    if a:
        stale = a["docs_fingerprint"] != ingest.docs_fingerprint(conn, oid)
        st.caption(f"Written {a['created_at']} by {a['model']} · cost ${a['cost_usd']:.2f}"
                   + (" · documents have changed since this brief" if stale else ""))
        st.markdown(briefs.brief_html(json.loads(a["brief_json"])), unsafe_allow_html=True)
        st.caption(settings.FOOTER)
        with st.expander("Raw JSON"):
            st.json(json.loads(a["brief_json"]))
    else:
        st.write("No brief yet for this client.")
    if st.button("Write brief with Fable" if not a else "Rewrite brief", disabled=not ai.available()):
        with st.spinner("Reading the bid package. Large packages can take several minutes."):
            try:
                briefs.write_brief(conn, oid, c)
                st.rerun()
            except Exception as ex:
                st.error(f"Brief failed: {ex}")

# --- Upload ------------------------------------------------------------------
elif page == "Upload a bid":
    st.title("Upload a bid")
    st.write("Drop in the bid documents you downloaded (for example from Public Purchase or a city bid packet).")
    with st.form("upload"):
        title = st.text_input("Project title")
        owner = st.text_input("Owner (city, county, district...)")
        c1, c2 = st.columns(2)
        county = c1.text_input("County", "Sweetwater")
        city = c2.text_input("City")
        due = st.text_input("Bid due (YYYY-MM-DD HH:MM, optional)")
        files = st.file_uploader("Bid documents", accept_multiple_files=True)
        if st.form_submit_button("Create opportunity"):
            if not title or not files:
                st.error("A title and at least one file are needed.")
            else:
                new_id = ingest.create_manual_opportunity(
                    conn, title, owner, county, city, due.strip().replace(" ", "T") or None,
                    [(f.name, f.getvalue()) for f in files])
                st.session_state["opp_id"] = new_id
                st.success("Created. Open it from the Opportunity page to write a brief.")

# --- Clients -----------------------------------------------------------------
elif page == "Clients":
    st.title("Clients")
    cl = clients()
    names = [c["name"] for c in cl] + ["+ New client"]
    pick = st.selectbox("Client", names)
    profile, path = {}, None
    if pick != "+ New client":
        row = next(c for c in cl if c["name"] == pick)
        path = Path(row["profile_yaml_path"])
        profile = yaml.safe_load(path.read_text()) or {}
    with st.form("client"):
        name = st.text_input("Name", profile.get("name", ""), disabled=path is not None)
        tier = st.selectbox("Tier", ["finder", "department", "full"],
                            index=["finder", "department", "full"].index(profile.get("tier", "finder")))
        email = st.text_input("Contact email", profile.get("contact_email", ""))
        home = st.text_input("Home base", profile.get("home_base", "Rock Springs, WY"))
        miles = st.number_input("Max travel miles", 0, 1000, int(profile.get("max_travel_miles") or 150))
        counties = st.text_input("Counties (comma separated)", ", ".join(profile.get("counties") or []))
        trades = st.multiselect("Trades", ai.TRADE_TAGS, [t for t in profile.get("trades") or [] if t in ai.TRADE_TAGS])
        c1, c2 = st.columns(2)
        smin = c1.number_input("Job size min ($)", 0, 10**9, int(profile.get("job_size_min") or 0), step=5000)
        smax = c2.number_input("Job size max ($)", 0, 10**9, int(profile.get("job_size_max") or 0), step=50000)
        bs = c1.number_input("Bonding capacity, single ($, 0 = unknown)", 0, 10**10, int(profile.get("bonding_capacity_single") or 0), step=50000)
        ba = c2.number_input("Bonding capacity, aggregate ($, 0 = unknown)", 0, 10**10, int(profile.get("bonding_capacity_aggregate") or 0), step=50000)
        preq = st.checkbox("WYDOT prequalified", bool(profile.get("wydot_prequalified")))
        res_opts = ["unknown", "yes", "no"]
        res = st.selectbox("Wyoming resident certified", res_opts,
                           index=res_opts.index(str(profile.get("wyoming_resident_certified") or "unknown").lower()
                                                if str(profile.get("wyoming_resident_certified") or "unknown").lower() in res_opts else "unknown"))
        notes = st.text_area("Notes", profile.get("notes", ""))
        if st.form_submit_button("Save profile"):
            final_name = profile.get("name") or name.strip()
            if not final_name:
                st.error("A name is needed.")
            else:
                profile.update({
                    "name": final_name, "tier": tier, "contact_email": email, "home_base": home,
                    "max_travel_miles": int(miles), "counties": [x.strip() for x in counties.split(",") if x.strip()],
                    "trades": trades, "job_size_min": int(smin) or None, "job_size_max": int(smax) or None,
                    "bonding_capacity_single": int(bs) or None, "bonding_capacity_aggregate": int(ba) or None,
                    "wydot_prequalified": preq, "wyoming_resident_certified": None if res == "unknown" else res,
                    "notes": notes})
                for k, v in {"wydot_prequal_classes": [], "licenses": [], "past_projects": [],
                             "competitors_to_watch": [], "insurance": {}}.items():
                    profile.setdefault(k, v)
                if path is None:
                    slug = "".join(ch if ch.isalnum() else "_" for ch in final_name.lower()).strip("_")
                    path = settings.CLIENTS_DIR / f"{slug}.yaml"
                path.write_text(yaml.safe_dump(profile, sort_keys=False, allow_unicode=True))
                match.sync_clients(conn)
                match.run_matching(conn)
                st.success(f"Saved {path.name} and re-scored matches.")

# --- Matches -----------------------------------------------------------------
elif page == "Matches":
    st.title("Matches")
    cl = clients()
    if not cl:
        st.info("No clients yet.")
        st.stop()
    c = st.selectbox("Client", cl, format_func=lambda r: r["name"])
    if st.button("Re-score now"):
        match.run_matching(conn)
    rows = conn.execute(
        "SELECT m.*, o.title, o.owner_name, o.due_datetime FROM matches m JOIN opportunities o ON o.id=m.opportunity_id"
        " WHERE m.client_id=? AND o.status='open' ORDER BY m.score DESC", (c["id"],)).fetchall()
    st.caption(f"{len(rows)} open bids scored. {match.BRIEF_THRESHOLD}+ go in the weekly report and get a Fable brief.")
    decisions = ["pending", "go", "no_go", "bidding", "submitted"]
    for m in rows:
        with st.container(border=True):
            a, b, d = st.columns([5, 2, 1])
            a.markdown(f"**{m['score']}** · **{m['title']}**  \n{m['owner_name'] or ''} · due {m['due_datetime'] or 'unknown'}  \n{m['reason']}")
            new = b.selectbox("Decision", decisions, index=decisions.index(m["decision"]), key=f"dec{m['id']}")
            if new != m["decision"]:
                conn.execute("UPDATE matches SET decision=?, updated_at=? WHERE id=?", (new, db.now(), m["id"]))
                conn.commit()
            d.button("Open", key=f"mo{m['id']}", on_click=open_opportunity, args=(m["opportunity_id"],))

# --- Outbox ------------------------------------------------------------------
elif page == "Outbox":
    st.title("Outbox")
    st.write("Nothing is sent until you click Approve. In Phase 1 every email goes only to "
             f"REPORT_TO (`{settings.env('REPORT_TO') or 'not set'}`), never to a client.")
    if st.button("Build this week's report for each client"):
        st.success(f"{reports.queue_weekly(conn)} report(s) queued below.")
    for r in conn.execute("SELECT o.*, c.name client FROM outbox o LEFT JOIN clients c ON c.id=o.client_id ORDER BY o.id DESC LIMIT 50").fetchall():
        with st.expander(f"[{r['status']}] {r['subject']} · created {r['created_at']}", expanded=r["status"] == "pending"):
            if r["error"]:
                st.error(r["error"])
            st.components.v1.html(r["html"], height=500, scrolling=True)
            a, b = st.columns(2)
            if r["status"] != "sent" and a.button("Approve and send to me", key=f"send{r['id']}"):
                result = reports.send_approved(conn, r["id"])
                (st.success if result == "sent" else st.error)(result)
            if r["status"] != "sent" and b.button("Discard", key=f"del{r['id']}"):
                conn.execute("DELETE FROM outbox WHERE id=?", (r["id"],))
                conn.commit()
                st.rerun()

# --- Sources health ----------------------------------------------------------
elif page == "Sources health":
    st.title("Sources health")
    for s in conn.execute("SELECT * FROM sources ORDER BY method DESC, name").fetchall():
        with st.container(border=True):
            st.markdown(f"**{s['name']}** · {s['method']} · {s['check_freq']}  \n{s['url'] or ''}")
            if s["method"] == "scrape":
                st.write(f"Last checked: {s['last_checked'] or 'never'} · status: {s['last_status'] or 'n/a'} · "
                         f"items: {s['last_item_count'] if s['last_item_count'] is not None else 'n/a'}")
            if s["alert"]:
                st.warning(s["alert"] + (f"  \n`{s['last_error']}`" if s["last_error"] else ""))
            if s["notes"]:
                st.caption(s["notes"])

# --- AI cost -----------------------------------------------------------------
elif page == "AI cost":
    st.title("AI cost")
    month = conn.execute("SELECT COALESCE(SUM(cost_usd),0) c FROM ai_usage WHERE ts>=date('now','start of month')").fetchone()["c"]
    st.metric("This month", f"${month:.2f}")
    st.subheader("By client, this month")
    st.dataframe([dict(r) for r in conn.execute(
        "SELECT COALESCE(c.name,'(shared: triage)') client, COUNT(*) calls, ROUND(SUM(u.cost_usd),2) usd"
        " FROM ai_usage u LEFT JOIN clients c ON c.id=u.client_id WHERE u.ts>=date('now','start of month')"
        " GROUP BY 1 ORDER BY usd DESC").fetchall()], use_container_width=True)
    st.subheader("By month and model")
    st.dataframe([dict(r) for r in conn.execute(
        "SELECT substr(ts,1,7) month, model, purpose, COUNT(*) calls, SUM(input_tokens) input_tokens,"
        " SUM(output_tokens) output_tokens, ROUND(SUM(cost_usd),2) usd FROM ai_usage GROUP BY 1,2,3 ORDER BY 1 DESC").fetchall()],
        use_container_width=True)
