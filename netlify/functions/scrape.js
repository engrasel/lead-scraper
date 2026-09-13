const fetch = require("node-fetch");

// ── Lead extraction patterns ──
const PATTERNS = {
  email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,7}\b/gi,
  phone: /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g,
  website: /https?:\/\/(?:www\.)?[a-zA-Z0-9][-a-zA-Z0-9]*\.[a-zA-Z]{2,}(?:\/[^\s)\]"'<>,]*)*/g,
  rating: /(\d\.\d)\s*(?:out of\s*5|\/\s*5|★|stars?|rating)?/g,
  hourlyRate: /([<>]?\s*\$[\d,]+\s*[-–]\s*\$[\d,]+\s*\/\s*hr)|(<\s*\$\d+\s*\/\s*hr)/g,
  projectSize: /(\$[\d,]+\+)/g,
  employees: /(\d{1,4}\s*[-–]\s*\d{1,4})/g,
  location: /([A-Z][a-z]+(?:\s[A-Z][a-z]+)*,\s*[A-Z][A-Za-z\s]+)/g,
};

const JUNK_EMAILS = new Set([
  "example@example.com", "info@example.com", "test@test.com",
  "email@example.com", "name@email.com",
]);

const SKIP_DOMAINS = [
  "clutch.co", "designrush", "goodfirms", "google.com",
  "facebook.com", "twitter.com", "linkedin.com/in/",
  "instagram.com", "youtube.com", "github.com",
  "cdn.", "fonts.", "static.", "pixel.", "analytics.",
  "w3.org", "schema.org", "gstatic.com",
];

// ── Fetch page via Jina Reader (FREE) ──
async function fetchPageJina(url) {
  const jinaUrl = `https://r.jina.ai/${url}`;
  const resp = await fetch(jinaUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      Accept: "text/plain",
    },
    timeout: 60000,
  });

  if (resp.ok) return await resp.text();

  // Fallback: direct fetch
  const directResp = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      Accept: "text/html",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: "https://www.google.com/",
    },
    timeout: 30000,
  });

  if (directResp.ok) {
    const html = await directResp.text();
    // Strip HTML tags for plain text
    return html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, "\n")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\n{3,}/g, "\n\n");
  }

  throw new Error(`Failed to fetch: HTTP ${directResp.status}`);
}

// ── Extract leads from text ──
function extractLeads(text, sourceUrl) {
  const leads = [];
  const lines = text.split("\n");
  let current = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Detect: "CompanyName 4.8 125 reviews"
    const nameMatch = line.match(
      /^([A-Z][A-Za-z0-9\s&.'\-]+?)\s+(\d\.\d)\s+(\d+)\s+reviews?/
    );
    if (nameMatch) {
      if (current && current.company_name) leads.push(current);
      current = newLead(nameMatch[1].trim(), nameMatch[2], nameMatch[3], sourceUrl);
      continue;
    }

    // Alt: company name on its own line, rating nearby
    if (!current) {
      if (/^[A-Z][A-Za-z0-9\s&.'\-]{2,50}$/.test(line)) {
        const next = lines.slice(i + 1, i + 5).join(" ");
        const rateM = next.match(/(\d\.\d)\s*(\d+)\s*reviews?/);
        if (rateM) {
          if (current && current.company_name) leads.push(current);
          current = newLead(line.trim(), rateM[1], rateM[2], sourceUrl);
          continue;
        }
      }
    }

    if (!current) continue;

    // Location
    const locM = line.match(/([A-Z][a-z]+(?:\s[A-Z][a-z]+)*,\s*[A-Z][A-Za-z\s]+)/);
    if (locM && current.location === "N/A" && locM[1].includes(",") && locM[1].length < 60) {
      current.location = locM[1].trim();
    }

    // Hourly rate
    const hrM = line.match(/([<>]?\s*\$[\d,]+\s*[-–]\s*\$[\d,]+\s*\/\s*hr)|(<\s*\$\d+\s*\/\s*hr)/);
    if (hrM && current.hourly_rate === "N/A") {
      current.hourly_rate = (hrM[1] || hrM[2]).trim();
    }

    // Project size
    if (/^\$[\d,]+\+$/.test(line) && current.min_project_size === "N/A") {
      current.min_project_size = line.trim();
    }

    // Employees
    const empM = line.match(/^(\d{1,4}\s*[-–]\s*\d{1,4})$/);
    if (empM && current.employees === "N/A") {
      const nums = empM[1].match(/\d+/g);
      if (nums && nums.length === 2 && +nums[0] >= 2 && +nums[1] <= 10000) {
        current.employees = empM[1].trim();
      }
    }

    // Services
    const svcM = line.match(/^(\d+%)\s+(.+)$/);
    if (svcM) {
      const svc = `${svcM[1]} ${svcM[2]}`;
      if (current.services === "N/A") current.services = svc;
      else if (current.services.length < 200) current.services += `; ${svc}`;
    }

    // Focus areas
    const focusM = line.match(
      /^(\d+%\s+(?:Shopify|Magento|WooCommerce|WordPress|Big\s*Commerce|Wix|React|Angular|Vue|Laravel|Django|Node).*)$/i
    );
    if (focusM) {
      if (current.focus_areas === "N/A") current.focus_areas = focusM[1];
      else if (current.focus_areas.length < 150) current.focus_areas += `; ${focusM[1]}`;
    }

    // Email
    const emailM = line.match(/\b([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,7})\b/i);
    if (emailM && !JUNK_EMAILS.has(emailM[1].toLowerCase()) && !/\.(png|jpg|svg|gif)$/i.test(emailM[1])) {
      current.email = emailM[1].toLowerCase();
    }

    // Phone
    const phoneM = line.match(/(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/);
    if (phoneM && current.phone === "N/A" && phoneM[0].replace(/\D/g, "").length >= 10) {
      current.phone = phoneM[0].trim();
    }
  }

  if (current && current.company_name) leads.push(current);

  // Fallback: bulk extraction
  if (leads.length === 0) {
    return extractBulk(text, sourceUrl);
  }

  return leads;
}

function extractBulk(text, sourceUrl) {
  const leads = [];
  const emails = [...new Set((text.match(PATTERNS.email) || []).map((e) => e.toLowerCase()))].filter(
    (e) => !JUNK_EMAILS.has(e) && !/\.(png|jpg|svg|gif)$/i.test(e)
  );

  const websites = [...new Set(text.match(PATTERNS.website) || [])].filter(
    (w) => !SKIP_DOMAINS.some((d) => w.includes(d))
  );

  for (const email of emails.slice(0, 50)) {
    const lead = newLead(`Lead (${email.split("@")[1]})`, "N/A", "N/A", sourceUrl);
    lead.email = email;
    leads.push(lead);
  }

  const leadEmails = new Set(leads.map((l) => l.email));
  for (const website of websites.slice(0, 30)) {
    try {
      const domain = new URL(website).hostname.replace("www.", "").split(".")[0];
      const lead = newLead(domain.charAt(0).toUpperCase() + domain.slice(1), "N/A", "N/A", sourceUrl);
      lead.website = website;
      leads.push(lead);
    } catch {}
  }

  return leads;
}

function newLead(name, rating, reviews, source) {
  return {
    company_name: name,
    rating: rating || "N/A",
    reviews_count: reviews || "N/A",
    location: "N/A",
    hourly_rate: "N/A",
    min_project_size: "N/A",
    employees: "N/A",
    website: "N/A",
    email: "N/A",
    phone: "N/A",
    services: "N/A",
    focus_areas: "N/A",
    source_url: source,
  };
}

// ── Netlify Function Handler ──
exports.handler = async (event) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: corsHeaders, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  try {
    const { url } = JSON.parse(event.body);
    if (!url) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: "URL required" }),
      };
    }

    const text = await fetchPageJina(url);
    const leads = extractLeads(text, url);

    // Sort by rating
    leads.sort((a, b) => {
      const rA = parseFloat(a.rating) || 0;
      const rB = parseFloat(b.rating) || 0;
      return rB - rA;
    });

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        success: true,
        count: leads.length,
        leads,
        scraped_at: new Date().toISOString(),
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
