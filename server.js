const express = require("express");
const { Readable } = require("stream");

const app = express();
const port = process.env.PORT || 3000;

const BOT_UA =
  "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)";
const CACHE_MS = Number(process.env.CACHE_MS || 5 * 60 * 1000);
const cache = new Map();

function htmlEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function serializeForInlineScript(value) {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("</script", "<\\/script");
}

function decodeJsonStyleString(raw) {
  const unicodeDecoded = raw.replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  );
  return unicodeDecoded
    .replaceAll("\\u0026", "&")
    .replaceAll("\\/", "/")
    .replaceAll('\\"', '"')
    .replaceAll("&amp;", "&");
}

function decodeHtmlEntities(value) {
  let text = String(value ?? "");
  text = text.replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(Number(dec)));
  text = text.replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) =>
    String.fromCodePoint(parseInt(hex, 16))
  );
  const named = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    "#064": "@"
  };
  text = text.replace(/&([a-zA-Z#0-9]+);/g, (m, name) => named[name] || m);
  return text;
}

function cleanDisplayText(value) {
  return decodeHtmlEntities(value).replace(/\s+/g, " ").trim();
}

function stripOuterQuotes(value) {
  return value
    .replace(/^["'\u201c\u201d]+/, "")
    .replace(/["'\u201c\u201d]+$/, "")
    .trim();
}

function sanitizeInstaTitle(rawTitle) {
  if (!rawTitle) return null;
  let t = cleanDisplayText(rawTitle);
  t = t.replace(/^[^:]{1,80}\s+on Instagram:\s*/i, "");
  t = t.replace(
    /\s*-\s*[\d.,]+[KMB]?\s+likes?,\s*[\d.,]+[KMB]?\s+comments?\s*-\s*.*$/i,
    ""
  );
  t = t.replace(/\s*-\s*[\d.,]+[KMB]?\s+likes?.*$/i, "");
  t = stripOuterQuotes(t);
  return t || null;
}

function sanitizeInstaDescription(rawDescription, sanitizedTitle) {
  if (!rawDescription) return null;
  let d = cleanDisplayText(rawDescription);
  d = d.replace(/^[^:]{1,80}\s+on Instagram:\s*/i, "");
  d = d.replace(/\s*-\s*[\d.,]+[KMB]?\s+likes?.*$/i, "");
  d = stripOuterQuotes(d);
  if (sanitizedTitle && d.toLowerCase() === sanitizedTitle.toLowerCase()) {
    return "Instagram video";
  }
  return d || null;
}

function parseMeta(html, key, isName = false) {
  const attr = isName ? "name" : "property";
  const re = new RegExp(
    `<meta[^>]*${attr}=["']${key}["'][^>]*content=["']([^"']+)["'][^>]*>`,
    "i"
  );
  const m = html.match(re);
  return m ? decodeJsonStyleString(m[1]) : null;
}

function parseVideoUrl(html) {
  const ogVideo = parseMeta(html, "og:video");
  if (ogVideo) return ogVideo;

  const patterns = [
    /"video_url":"([^"]+)"/i,
    /"video_versions":\[\{"type":[^,]+,"url":"([^"]+)"/i,
    /"video_versions":\[\{[^}]*"url":"([^"]+)"/i,
    /"xdt_shortcode_media":\{[^}]*"video_url":"([^"]+)"/i,
    /"video_url":"(https:\\\/\\\/[^"]+)"/i,
    /"contentUrl":"([^"]+)"/i,
    /"videoVersions":\[\{"type":[^,]+,"url":"([^"]+)"/i
  ];

  for (const pattern of patterns) {
    const m = html.match(pattern);
    if (m) return decodeJsonStyleString(m[1]);
  }

  return null;
}

function parseNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function inferMediaExtension(urlString, fallback = "bin") {
  try {
    const pathname = new URL(urlString).pathname || "";
    const match = pathname.match(/\.([a-zA-Z0-9]+)$/);
    return match ? match[1].toLowerCase() : fallback;
  } catch {
    return fallback;
  }
}

function normalizeInstagramImageUrl(urlString) {
  // Instagram now signs the full image URL, including the `stp` crop token, with
  // the `oh` parameter. Mutating any part of the URL (e.g. stripping `stp` crop
  // segments) invalidates that signature and the CDN responds 403 "URL signature
  // mismatch". Return the URL untouched.
  return urlString;
}

function getCandidateArea(candidate) {
  const width = parseNumber(
    candidate?.width ?? candidate?.config_width ?? candidate?.original_width,
    0
  );
  const height = parseNumber(
    candidate?.height ?? candidate?.config_height ?? candidate?.original_height,
    0
  );
  return width * height;
}

function pickBestImageCandidate(item) {
  const candidates = [
    ...(Array.isArray(item?.image_versions2?.candidates)
      ? item.image_versions2.candidates
      : []),
    ...(Array.isArray(item?.display_resources) ? item.display_resources : [])
  ]
    // GraphQL `display_resources` expose the URL as `src`; image_versions2 uses `url`.
    .map((candidate) => ({ ...candidate, url: candidate?.url || candidate?.src }))
    .filter((candidate) => candidate?.url);

  if (!candidates.length) return null;

  return candidates.reduce((best, candidate) => {
    if (!best) return candidate;
    return getCandidateArea(candidate) > getCandidateArea(best) ? candidate : best;
  }, null);
}

function normalizeMediaItem(item) {
  if (!item || typeof item !== "object") return null;

  const bestImageCandidate = pickBestImageCandidate(item);
  const rawUrl =
    bestImageCandidate?.url ||
    item.display_url ||
    item.display_src ||
    item.image_url ||
    null;
  const imageUrl = rawUrl ? normalizeInstagramImageUrl(rawUrl) : null;
  const videoUrl =
    item.video_url ||
    item?.video_versions?.[0]?.url ||
    item?.clips_metadata?.original_sound_info?.progressive_download_url ||
    null;
  const width = parseNumber(item?.dimensions?.width, 720);
  const height = parseNumber(item?.dimensions?.height, 1280);
  const isVideo = Boolean(videoUrl);
  const sourceUrl = videoUrl || imageUrl;

  if (!sourceUrl) return null;

  return {
    type: isVideo ? "video" : "image",
    sourceUrl,
    posterUrl: imageUrl || videoUrl,
    width,
    height,
    extension: isVideo ? "mp4" : inferMediaExtension(sourceUrl, "jpg")
  };
}

function extractMediaItems(media) {
  const sidecarEdges = media?.edge_sidecar_to_children?.edges;
  if (Array.isArray(sidecarEdges) && sidecarEdges.length) {
    return sidecarEdges
      .map((edge) => normalizeMediaItem(edge?.node || edge))
      .filter(Boolean);
  }

  const carouselMedia = media?.carousel_media;
  if (Array.isArray(carouselMedia) && carouselMedia.length) {
    return carouselMedia.map(normalizeMediaItem).filter(Boolean);
  }

  const single = normalizeMediaItem(media);
  return single ? [single] : [];
}

function isAllowedMediaHost(urlString) {
  try {
    const u = new URL(urlString);
    if (u.protocol !== "https:") return false;
    return (
      u.hostname.endsWith(".fbcdn.net") ||
      u.hostname === "fbcdn.net" ||
      u.hostname.endsWith(".cdninstagram.com") ||
      u.hostname === "cdninstagram.com"
    );
  } catch {
    return false;
  }
}

function encodeMediaUrl(urlString) {
  return Buffer.from(urlString, "utf8").toString("base64url");
}

function decodeMediaUrl(token) {
  return Buffer.from(token, "base64url").toString("utf8");
}

function getCanonicalInstaUrl(type, shortcode, query = new URLSearchParams()) {
  const qs = query.toString();
  return `https://www.instagram.com/${type}/${shortcode}/${qs ? `?${qs}` : ""}`;
}

function getPublicBaseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) {
    return process.env.PUBLIC_BASE_URL.replace(/\/+$/, "");
  }
  const proto = req.get("x-forwarded-proto") || req.protocol || "https";
  const host = req.get("x-forwarded-host") || req.get("host");
  return `${proto}://${host}`;
}

const IG_APP_ID = "936619743392459";
// Web UA used for the GraphQL call; the Discordbot UA on the page fetch is enough
// to mint the csrftoken cookie that the GraphQL endpoint requires.
const IG_WEB_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
// doc_id for PolarisPostActionLoadPostQueryQuery (shortcode -> xdt_shortcode_media).
// Overridable via env in case Instagram rotates it.
const IG_POST_DOC_ID = process.env.IG_POST_DOC_ID || "8845758582119845";

function extractInstaAuth(res) {
  const jar =
    typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  const cookie = jar.map((c) => c.split(";")[0]).join("; ");
  const csrf = (cookie.match(/csrftoken=([^;]+)/) || [])[1] || "";
  return { cookie, csrf };
}

async function tryFetchFromGraphql(shortcode, auth) {
  const { cookie, csrf } = auth || {};
  if (!cookie || !csrf) {
    throw new Error("Missing Instagram session cookies for GraphQL");
  }

  const body = new URLSearchParams({
    doc_id: IG_POST_DOC_ID,
    variables: JSON.stringify({ shortcode })
  });

  const res = await fetch("https://www.instagram.com/graphql/query", {
    method: "POST",
    headers: {
      "User-Agent": IG_WEB_UA,
      "X-IG-App-ID": IG_APP_ID,
      "X-CSRFToken": csrf,
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookie
    },
    body
  });

  if (!res.ok) {
    throw new Error(`GraphQL endpoint returned ${res.status}`);
  }

  const json = await res.json();
  const media = json?.data?.xdt_shortcode_media || null;
  if (!media) {
    throw new Error("GraphQL response did not contain media");
  }

  const mediaItems = extractMediaItems(media);
  if (!mediaItems.length) {
    throw new Error("GraphQL response did not include supported media");
  }

  const primaryMedia = mediaItems[0];

  return {
    mediaItems,
    title: media.title || media.accessibility_caption || "Instagram video",
    description:
      media.edge_media_to_caption?.edges?.[0]?.node?.text ||
      media.caption?.text ||
      "Instagram video proxy embed",
    image: primaryMedia.posterUrl || null,
    width: String(primaryMedia.width || 720),
    height: String(primaryMedia.height || 1280)
  };
}

async function fetchInstaEmbedData(type, shortcode) {
  const canonicalUrl = getCanonicalInstaUrl(type, shortcode, new URLSearchParams());
  const cacheKey = canonicalUrl;
  const fromCache = cache.get(cacheKey);
  const now = Date.now();
  if (fromCache && now - fromCache.createdAt < CACHE_MS) return fromCache.data;

  let title = null;
  let description = null;
  let image = null;
  let width = null;
  let height = null;
  let mediaItems = [];

  const res = await fetch(canonicalUrl, {
    headers: {
      "User-Agent": BOT_UA,
      Accept: "text/html,application/xhtml+xml"
    },
    redirect: "follow"
  });

  if (!res.ok) {
    throw new Error(`Instagram returned ${res.status}`);
  }

  const auth = extractInstaAuth(res);
  const html = await res.text();
  const parsedVideoUrl = parseVideoUrl(html);
  title = parseMeta(html, "og:title") || parseMeta(html, "twitter:title", true);
  description =
    parseMeta(html, "og:description") || parseMeta(html, "twitter:description", true);
  image = parseMeta(html, "og:image");
  width = parseMeta(html, "og:video:width");
  height = parseMeta(html, "og:video:height");
  if (parsedVideoUrl) {
    mediaItems = [
      {
        type: "video",
        sourceUrl: parsedVideoUrl,
        posterUrl: image || parsedVideoUrl,
        width: parseNumber(width, 720),
        height: parseNumber(height, 1280),
        extension: inferMediaExtension(parsedVideoUrl, "mp4")
      }
    ];
  }
  if (!mediaItems.length && image) {
    mediaItems = [
      {
        type: "image",
        sourceUrl: normalizeInstagramImageUrl(image),
        posterUrl: normalizeInstagramImageUrl(image),
        width: parseNumber(parseMeta(html, "og:image:width"), 1080),
        height: parseNumber(parseMeta(html, "og:image:height"), 1350),
        extension: "jpg"
      }
    ];
  }

  try {
    const jsonData = await tryFetchFromGraphql(shortcode, auth);
    const jsonHasPlayableVideo = jsonData.mediaItems.some((item) => item.type === "video");
    const currentHasPlayableVideo = mediaItems.some((item) => item.type === "video");

    if (
      jsonData.mediaItems.length &&
      (!currentHasPlayableVideo || jsonHasPlayableVideo)
    ) {
      mediaItems = jsonData.mediaItems;
    }
    title = title || jsonData.title;
    description = description || jsonData.description;
    image = image || jsonData.image;
    width = width || jsonData.width;
    height = height || jsonData.height;
  } catch (_err) {
    // Keep the external response simple; details are mostly operational noise.
  }

  if (!mediaItems.length) {
    throw new Error("Could not find supported media on the Instagram page");
  }

  const primaryMedia = mediaItems[0];
  const primaryVideo = mediaItems.find((item) => item.type === "video") || null;

  const sanitizedTitle = sanitizeInstaTitle(title) || `Instagram ${type}`;
  const sanitizedDescription =
    sanitizeInstaDescription(description, sanitizedTitle) || "Instagram media proxy embed";

  const data = {
    canonicalUrl,
    mediaItems,
    primaryType: primaryMedia.type,
    videoUrl: primaryVideo?.sourceUrl || null,
    title: sanitizedTitle,
    description: sanitizedDescription,
    image: image || primaryMedia.posterUrl || null,
    width: String(primaryMedia.width || parseNumber(width, 720)),
    height: String(primaryMedia.height || parseNumber(height, 1280))
  };

  cache.set(cacheKey, { createdAt: now, data });
  return data;
}

function renderMediaUrl(baseUrl, item) {
  if (item.type === "image") return item.sourceUrl;
  return `${baseUrl}/media/${encodeMediaUrl(item.sourceUrl)}.${item.extension}`;
}

function renderVideoEmbedPage(data, embedVideoUrl, options) {
  const { pageUrl, siteName } = options;
  const safeTitle = htmlEscape(data.title);
  const safeDescription = htmlEscape(data.description);
  const safeVideo = htmlEscape(embedVideoUrl || data.videoUrl);
  const safeImage = htmlEscape(data.image || "");
  const safeCanonicalUrl = htmlEscape(data.canonicalUrl);
  const safePageUrl = htmlEscape(pageUrl);
  const safeSiteName = htmlEscape(siteName);
  const safeWidth = htmlEscape(data.width);
  const safeHeight = htmlEscape(data.height);
  const safeMetaLine = htmlEscape(`${data.title} - ${data.description}`);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="canonical" href="${safeCanonicalUrl}" />
    <meta property="og:site_name" content="${safeSiteName}" />
    <title>${safeTitle}</title>
    <meta property="og:title" content="${safeTitle}" />
    <meta property="og:description" content="${safeDescription}" />
    <meta property="og:type" content="video.other" />
    <meta property="og:url" content="${safePageUrl}" />
    <meta property="og:video" content="${safeVideo}" />
    <meta property="og:video:secure_url" content="${safeVideo}" />
    <meta property="og:video:type" content="video/mp4" />
    <meta property="og:video:width" content="${safeWidth}" />
    <meta property="og:video:height" content="${safeHeight}" />
    <meta property="og:image" content="${safeImage}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${safeTitle}" />
    <meta name="twitter:description" content="${safeDescription}" />
    <meta name="twitter:image" content="${safeImage}" />
    <meta name="twitter:player" content="${safeVideo}" />
    <meta name="twitter:player:width" content="${safeWidth}" />
    <meta name="twitter:player:height" content="${safeHeight}" />
    <style>
      body { margin: 0; padding: 24px; font-family: system-ui, -apple-system, Segoe UI, sans-serif; background: #0a0a0a; color: #f2f2f2; }
      .wrap { max-width: 720px; margin: 0 auto; }
      .meta { font-size: 14px; color: #bdbdbd; margin-bottom: 12px; overflow-wrap: anywhere; }
      video { width: 100%; max-height: 80vh; object-fit: contain; border-radius: 12px; background: #000; }
      a { color: #7cd1ff; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="meta">${safeMetaLine}</div>
      <video controls playsinline poster="${safeImage}">
        <source src="${safeVideo}" type="video/mp4" />
      </video>
      <div class="meta">Original: <a href="${safeCanonicalUrl}" rel="noreferrer">${safeCanonicalUrl}</a></div>
    </div>
  </body>
</html>`;
}

function renderMediaEmbedPage(data, options) {
  const { pageUrl, siteName } = options;
  const primaryMedia = data.mediaItems[0];
  const carouselItems = data.mediaItems.map((item) => ({
    ...item,
    proxiedUrl: renderMediaUrl(options.baseUrl, item)
  }));
  const safeTitle = htmlEscape(data.title);
  const safeDescription = htmlEscape(data.description);
  const safeImage = htmlEscape(data.image || primaryMedia.posterUrl || "");
  const safeCanonicalUrl = htmlEscape(data.canonicalUrl);
  const safePageUrl = htmlEscape(pageUrl);
  const safeSiteName = htmlEscape(siteName);
  const safeWidth = htmlEscape(String(primaryMedia.width));
  const safeHeight = htmlEscape(String(primaryMedia.height));
  const safeMetaLine = htmlEscape(`${data.title} - ${data.description}`);
  const inlineCarouselJson = serializeForInlineScript(carouselItems);
  const ogType = "website";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="canonical" href="${safeCanonicalUrl}" />
    <meta property="og:site_name" content="${safeSiteName}" />
    <title>${safeTitle}</title>
    <meta property="og:title" content="${safeTitle}" />
    <meta property="og:description" content="${safeDescription}" />
    <meta property="og:type" content="${ogType}" />
    <meta property="og:url" content="${safePageUrl}" />
    <meta property="og:image" content="${safeImage}" />
    <meta property="og:image:width" content="${safeWidth}" />
    <meta property="og:image:height" content="${safeHeight}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${safeTitle}" />
    <meta name="twitter:description" content="${safeDescription}" />
    <meta name="twitter:image" content="${safeImage}" />
    <style>
      :root { color-scheme: dark; }
      body { margin: 0; padding: 24px; font-family: system-ui, -apple-system, Segoe UI, sans-serif; background: #0a0a0a; color: #f2f2f2; }
      .wrap { max-width: 720px; margin: 0 auto; }
      .meta { font-size: 14px; color: #bdbdbd; margin-bottom: 12px; overflow-wrap: anywhere; }
      .stage { position: relative; width: 100%; background: #000; border-radius: 16px; overflow: hidden; }
      .frame { display: grid; place-items: center; width: 100%; }
      .frame > img, .frame > video { width: 100%; height: auto; display: block; background: #000; }
      .nav { position: absolute; top: 50%; transform: translateY(-50%); border: 0; width: 44px; height: 44px; border-radius: 999px; background: rgba(15, 15, 15, 0.75); color: #fff; font-size: 24px; cursor: pointer; }
      .nav[disabled] { opacity: 0.35; cursor: default; }
      .nav.prev { left: 12px; }
      .nav.next { right: 12px; }
      .dots { display: flex; justify-content: center; gap: 8px; margin: 12px 0 0; }
      .dot { width: 8px; height: 8px; border-radius: 999px; background: rgba(255,255,255,0.3); }
      .dot.active { background: #fff; }
      .count { margin-top: 10px; text-align: center; color: #9e9e9e; font-size: 13px; }
      a { color: #7cd1ff; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="meta">${safeMetaLine}</div>
      <div class="stage">
        <div class="frame" id="frame"></div>
        <button class="nav prev" id="prev" aria-label="Previous media">&#8249;</button>
        <button class="nav next" id="next" aria-label="Next media">&#8250;</button>
      </div>
      <div class="dots" id="dots"></div>
      <div class="count" id="count"></div>
      <div class="meta">Original: <a href="${safeCanonicalUrl}" rel="noreferrer">${safeCanonicalUrl}</a></div>
    </div>
    <script id="media-data" type="application/json">${inlineCarouselJson}</script>
    <script>
      const items = JSON.parse(document.getElementById("media-data").textContent);
      const frame = document.getElementById("frame");
      const prev = document.getElementById("prev");
      const next = document.getElementById("next");
      const dots = document.getElementById("dots");
      const count = document.getElementById("count");
      let index = 0;

      function render() {
        const item = items[index];
        frame.style.aspectRatio = item.width + " / " + item.height;
        frame.replaceChildren();

        if (item.type === "video") {
          const video = document.createElement("video");
          video.controls = true;
          video.playsInline = true;
          if (item.posterUrl) video.poster = item.posterUrl;

          const source = document.createElement("source");
          source.src = item.proxiedUrl;
          source.type = "video/mp4";
          video.appendChild(source);
          frame.appendChild(video);
        } else {
          const image = document.createElement("img");
          image.src = item.proxiedUrl;
          image.alt = "";
          image.loading = "eager";
          frame.appendChild(image);
        }

        dots.innerHTML = items.map(function (_item, dotIndex) {
          return '<span class="dot' + (dotIndex === index ? ' active' : '') + '"></span>';
        }).join("");
        count.textContent = items.length > 1 ? (index + 1) + " / " + items.length : item.type;
        prev.disabled = items.length < 2;
        next.disabled = items.length < 2;
        prev.hidden = items.length < 2;
        next.hidden = items.length < 2;
      }

      prev.addEventListener("click", function () {
        if (items.length < 2) return;
        index = (index - 1 + items.length) % items.length;
        render();
      });

      next.addEventListener("click", function () {
        if (items.length < 2) return;
        index = (index + 1) % items.length;
        render();
      });

      render();
    </script>
  </body>
</html>`;
}

app.get("/:type(reel|reels|p|tv)/:shortcode", async (req, res) => {
  const { shortcode } = req.params;
  // Instagram's canonical single-reel path is `/reel/`; `/reels/` only resolves
  // as a redirect, so normalize before building the upstream URL.
  const type = req.params.type === "reels" ? "reel" : req.params.type;

  try {
    const data = await fetchInstaEmbedData(type, shortcode);
    const baseUrl = getPublicBaseUrl(req);
    const pageUrl = `${baseUrl}${req.originalUrl}`;
    const siteName = req.get("host") || new URL(baseUrl).host;
    const isSingleVideo = data.mediaItems.length === 1 && data.mediaItems[0].type === "video";
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=120");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    if (isSingleVideo) {
      const embedVideoUrl = `${baseUrl}/media/${encodeMediaUrl(data.mediaItems[0].sourceUrl)}.mp4`;
      return res.send(
        renderVideoEmbedPage(data, embedVideoUrl, {
          pageUrl,
          siteName
        })
      );
    }

    res.send(
      renderMediaEmbedPage(data, {
        baseUrl,
        pageUrl,
        siteName
      })
    );
  } catch (err) {
    const canonicalUrl = getCanonicalInstaUrl(type, shortcode, new URLSearchParams());
    res.status(502).json({
      ok: false,
      error: err.message,
      fallback: canonicalUrl
    });
  }
});

app.get("/media/:token.mp4", async (req, res) => {
  return handleMediaProxy(req, res);
});

app.get("/media/:token.:ext", async (req, res) => {
  return handleMediaProxy(req, res);
});

async function handleMediaProxy(req, res) {
  try {
    const sourceUrl = decodeMediaUrl(req.params.token);
    if (!isAllowedMediaHost(sourceUrl)) {
      return res.status(400).json({ ok: false, error: "Invalid media source URL" });
    }

    const isVideoRequest = (req.params.ext || "").toLowerCase() === "mp4";
    const headers = {
      "User-Agent": BOT_UA,
      Accept: isVideoRequest ? "video/mp4,*/*;q=0.8" : "image/*,*/*;q=0.8"
    };
    if (req.headers.range) headers.Range = req.headers.range;

    const upstream = await fetch(sourceUrl, {
      headers,
      redirect: "follow"
    });
    if (!upstream.ok && upstream.status !== 206) {
      return res.status(502).json({
        ok: false,
        error: `Upstream media fetch failed: ${upstream.status}`
      });
    }

    const passHeaders = [
      "content-type",
      "content-length",
      "accept-ranges",
      "content-range",
      "cache-control",
      "last-modified",
      "etag"
    ];
    for (const key of passHeaders) {
      const value = upstream.headers.get(key);
      if (value) res.setHeader(key, value);
    }
    if (!res.getHeader("content-type")) {
      res.setHeader("content-type", isVideoRequest ? "video/mp4" : "image/jpeg");
    }

    res.status(upstream.status);
    if (!upstream.body) return res.end();
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}

app.get("/", (_req, res) => {
  res.type("text/plain").send(
    [
      "Instagram Embed Proxy",
      "",
      "Use: /reel/:shortcode or /p/:shortcode",
      "Example:",
      "  /reel/DSGp2RSidjE/?igsh=NTc4MTIwNjQ2YQ=="
    ].join("\n")
  );
});

app.listen(port, () => {
  console.log(`Instagram embed proxy listening on port ${port}`);
});
