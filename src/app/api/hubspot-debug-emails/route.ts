import { NextResponse } from "next/server";

const HUBSPOT_BASE = "https://api.hubapi.com";

function getToken() {
  const raw = process.env.HUBSPOT_PRIVATE_APP_TOKEN || "";
  // Strip surrounding quotes in case dotenv didn't remove them
  const t = raw.replace(/^["']|["']$/g, "").trim();
  if (!t) throw new Error("Missing HUBSPOT_PRIVATE_APP_TOKEN");
  return t;
}

async function hsFetch(url: string, init?: RequestInit) {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${getToken()}`,
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
    cache: "no-store",
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HubSpot ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

export async function GET() {
  const steps: Record<string, unknown> = {};

  try {
    // Step 1: pull first few deals to get company IDs
    const dealsUrl = `${HUBSPOT_BASE}/crm/v3/objects/deals/search`;
    const includedStage = process.env.INCLUDED_DEALSTAGE || "";
    const dealsBody = {
      filterGroups: includedStage
        ? [{ filters: [{ propertyName: "dealstage", operator: "EQ", value: includedStage }] }]
        : [],
      properties: ["dealname", "hs_primary_associated_company"],
      limit: 5,
    };

    let sampleCompanyIds: string[] = [];
    try {
      const dealsJson = await hsFetch(dealsUrl, { method: "POST", body: JSON.stringify(dealsBody) });
      const deals = (dealsJson.results || []) as Array<{ id: string; properties?: Record<string, unknown> }>;
      steps["1_deals_fetched"] = deals.map((d) => ({
        dealId: d.id,
        companyRaw: d.properties?.hs_primary_associated_company,
      }));

      sampleCompanyIds = deals
        .map((d) => {
          const raw = String(d.properties?.hs_primary_associated_company || "").trim();
          return raw.split(/[,\s;|]+/).find((p) => /^\d+$/.test(p.trim())) || "";
        })
        .filter(Boolean)
        .slice(0, 3);

      steps["2_company_ids"] = sampleCompanyIds;
    } catch (e) {
      steps["1_deals_error"] = String(e);
      return NextResponse.json({ steps }, { status: 200 });
    }

    if (!sampleCompanyIds.length) {
      steps["note"] = "No numeric company IDs found in sample deals";
      return NextResponse.json({ steps }, { status: 200 });
    }

    // Step 2: batch company→contact associations
    const assocUrl = `${HUBSPOT_BASE}/crm/v4/associations/companies/contacts/batch/read`;
    let contactIdsByCompany: Record<string, string> = {};
    try {
      const assocJson = await hsFetch(assocUrl, {
        method: "POST",
        body: JSON.stringify({ inputs: sampleCompanyIds.map((id) => ({ id })) }),
      });
      steps["3_assoc_raw_response"] = assocJson;

      for (const result of assocJson.results || []) {
        const companyId = String(result.from?.id || "");
        const firstContact = result.to?.[0];
        const contactId = String(firstContact?.toObjectId || firstContact?.id || "");
        if (companyId && contactId) contactIdsByCompany[companyId] = contactId;
      }
      steps["4_contact_ids_by_company"] = contactIdsByCompany;
    } catch (e) {
      steps["3_assoc_error"] = String(e);
      return NextResponse.json({ steps }, { status: 200 });
    }

    const contactIds = Object.values(contactIdsByCompany);
    if (!contactIds.length) {
      steps["note"] = "No contacts associated with these companies in HubSpot";
      return NextResponse.json({ steps }, { status: 200 });
    }

    // Step 3: batch-read contacts for email
    const contactUrl = `${HUBSPOT_BASE}/crm/v3/objects/contacts/batch/read`;
    try {
      const contactJson = await hsFetch(contactUrl, {
        method: "POST",
        body: JSON.stringify({
          properties: ["email", "firstname", "lastname"],
          inputs: contactIds.map((id) => ({ id })),
        }),
      });
      steps["5_contacts_raw"] = contactJson;
      steps["6_emails"] = (contactJson.results || []).map((c: { id: string; properties?: Record<string, unknown> }) => ({
        contactId: c.id,
        email: c.properties?.email,
        name: `${c.properties?.firstname || ""} ${c.properties?.lastname || ""}`.trim(),
      }));
    } catch (e) {
      steps["5_contacts_error"] = String(e);
    }
  } catch (e) {
    steps["fatal_error"] = String(e);
  }

  return NextResponse.json({ steps }, { status: 200 });
}
