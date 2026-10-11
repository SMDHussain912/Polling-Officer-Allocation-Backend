# Notification Setup Guide (SMS + WhatsApp + Message Settings)
> Plain-words guide for admins. Tech values live in `backend/.env` (never in
> React, never committed). Placeholders live in `backend/.env.example`.

## 1. What works right now (no credentials needed)
- **Demo SMS**: `SMS_PROVIDER=mock` stores messages as `DEMO_SENT` — full
  UI flow (send → history → retry) with zero cost and zero real messages.
- **Message Settings page** (`/settings/notifications`): edit all 3 channel
  templates with click-to-insert variables + live preview + test-to-me.
- **Email**: unchanged Gmail OAuth flow (`/auth/google`).

## 2. WhatsApp Cloud API (Meta) — required steps
1. **Meta App**: https://developers.facebook.com → Create App → add
   **WhatsApp** product → copy the **Phone Number ID**.
   - `WHATSAPP_PHONE_NUMBER_ID=1166531953219753` (already the default).
   - `WHATSAPP_GRAPH_VERSION=v25.0`.
2. **Access token**: WhatsApp → API Setup → Temporary token (24h, for testing)
   or create a **permanent System User token** (WhatsApp Business Settings →
   System Users → Add Assets → generate token with `whatsapp_business_messaging`).
   - `WHATSAPP_ACCESS_TOKEN=<paste here>` — backend `.env` ONLY.
3. **Test with hello_world** (Meta provides this template on every number):
   open Message Settings → WhatsApp tab → type YOUR mobile → press
   **Test hello_world**. A green success means Meta accepted it.
4. **Real allocation template**: WhatsApp Manager → Message Templates →
   create e.g. `polling_duty_allocation` (language `en_US`) with body like:
   `Dear {{1}}, you are allocated to booth {{2}} ({{3}}), {{4}} mandal. Report: {{5}}.`
   Wait for **APPROVED**, then type that exact name into Message Settings →
   WhatsApp → Approved Template Name + the matching parameter order.
5. **Delivery tracking (webhooks)**: Meta needs a PUBLIC https URL:
   - `GET /api/webhooks/whatsapp` (verify token = `WHATSAPP_VERIFY_TOKEN`).
   - `POST /api/webhooks/whatsapp` (signed with `WHATSAPP_APP_SECRET`,
     verified with constant-time HMAC — statuses become DELIVERED/READ/FAILED).
   - Without this step, messages stay at **Sent to WhatsApp** (accepted by
     Meta, delivery unknown) — by design, never auto-claimed.
6. **Costs**: Meta bills per conversation (user vs business-initiated). Check
   the current rate card in WhatsApp Manager → Billing before bulk sends.

## 3. SMS via MSG91 (India) — required steps
1. Sign up at https://msg91.com → verify company/KYC.
2. **Sender ID**: Headers → apply for e.g. `ELCION` (6-letter, approved).
   - `SMS_SENDER_ID=ELCION`.
3. **DLT registration** (mandatory in India): register Entity + Header + Content
   Template on https://www.ucc-bsnl.co.in / Jio/Voda DLT portal → get the
   **DLT Template ID** → paste into Message Settings (SMS tab) or
   `SMS_DLT_TEMPLATE_ID=`.
4. **Authkey**: API → copy authkey → `SMS_API_KEY=<authkey>`, then:
   `SMS_PROVIDER=msg91`.
5. Optional **Flow**: create a Flow in MSG91 → `MSG91_FLOW_ID=<flow id>` for
   variable-mapped sends.
6. **Delivery reports**: MSG91 → Webhooks → point to
   `POST /api/webhooks/sms` with `SMS_WEBHOOK_SECRET=<shared secret>`.
   Only these callbacks flip SMS to DELIVERED.
7. **Costs**: MSG91 sells credit slabs (route 4 = transactional). Confirm the
   per-SMS rate card + GST before buying credits.

## 4. Safe manual verification (no accidental bulk)
1. Open Message Settings → pick SMS tab → type YOUR number → **Send Test to Me**.
2. Repeat for WhatsApp (**Test hello_world** first, then your template).
3. Allocation page → one officer → **SMS** button → check history row.
4. Notifications page → confirm status → press **Retry** on a failed row only.
5. Bulk: Allocation → **Notify All Allocated** → ConfirmModal shows the count
   (max 100/run, rate-limited to 10 bulk runs per 10 min).

## 5. Troubleshooting (plain words)
| What you see | What it means | What to do |
|---|---|---|
| `WHATSAPP_NOT_CONFIGURED` | Token or Phone ID missing | Fill both in backend `.env`, restart server |
| `Meta error 132000` | Template name wrong / not approved | Copy exact approved name into settings |
| `Meta error 131030` | Number not on WhatsApp / invalid | Check the mobile digits |
| `SMS_NOT_CONFIGURED` | SMS_API_KEY missing | Paste MSG91 authkey, set `SMS_PROVIDER=msg91` |
| `MSG91 error` | Sender/DLT rejected | Confirm approved Sender ID + DLT Template ID |
| `SMS_TIMEOUT` / retry offered | Network/provider slow | Press Retry (max 3 tries, auto-blocked after) |
| `Invalid phone number` | Bad digits | Fix the mobile on the Officers page (10 digits) |
| Message stuck at Sent to WhatsApp | No webhook yet | Configure Meta webhook (step 5 above) |
