// ============================================================================
// PONT DIGITAL — SUPER ADMIN WORKER (CLOUDFLARE WORKERS + D1)
// Domaine : SuperAdmin-Pontdigital.nyxia.top
// Base D1 : pont-digital (6686e683-69d3-4044-9566-309480bc949e)
// Assets  : /images/FavIcon.png (onglet), /images/NyXia.png (avatar),
//           /css/index.css, /js/starry-bg.js
// ============================================================================

const FAVICON_URL = '/images/FavIcon.png';
const NYXIA_AVATAR_URL = '/images/NyXia.png';
const CSS_URL = '/css/index.css';
const STARRY_JS_URL = '/js/starry-bg.js';

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      // 1. Servir les fichiers statiques (/images/*, /css/*, /js/*) et le favicon
      if (path === '/favicon.ico') {
        return Response.redirect(`${url.origin}${FAVICON_URL}`, 302);
      }
      if (path.startsWith('/images/') || path.startsWith('/css/') || path.startsWith('/js/')) {
        if (env.ASSETS) {
          const assetRes = await env.ASSETS.fetch(request);
          if (assetRes.status !== 404) return assetRes;
          const publicUrl = new URL(request.url);
          publicUrl.pathname = `/public${path}`;
          return env.ASSETS.fetch(new Request(publicUrl.toString(), request));
        }
      }

      // 2. Vérification de la liaison D1 et migration complète du schéma
      if (!env.DB) {
        return renderErrorHTML('Liaison D1 manquante', 'La base de données DB (pont-digital) n’est pas liée à ce Worker dans Cloudflare.');
      }
      await ensureDatabaseSchema(env.DB);

      // 3. Routes publiques d'authentification
      if (path === '/login' && request.method === 'POST') {
        return await handleLogin(request, env);
      }
      if (path === '/logout') {
        return new Response(null, {
          status: 302,
          headers: {
            'Location': '/',
            'Set-Cookie': 'pd_admin_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0'
          }
        });
      }

      // 4. Vérification de la session Super Admin
      const isAuthenticated = await verifySession(request, env);
      if (!isAuthenticated) {
        return new Response(renderLoginHTML(), {
          headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
      }

      // 5. Routes OAuth 2.0 Google Business Profile
      if (path === '/oauth/google/start') {
        return handleGoogleOAuthStart(url, env);
      }
      if (path === '/oauth/google/callback') {
        return await handleGoogleOAuthCallback(url, env);
      }
      if (path === '/oauth/google/select-location' && request.method === 'POST') {
        return await handleGoogleSelectLocation(request, env);
      }

      // 6. Routes API JSON (AJAX depuis le tableau de bord)
      if (path.startsWith('/api/')) {
        return await handleApiRequest(request, env, path, url);
      }

      // 7. Page principale du Super Admin
      const dashboardHtml = await renderDashboardHTML(env);
      return new Response(dashboardHtml, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    } catch (err) {
      return renderErrorHTML('Erreur technique interceptée', `${err.message}\n\n${err.stack || ''}`);
    }
  },

  // Tâche planifiée quotidienne (6h00 UTC) : synchronisation automatique des avis Google
  async scheduled(event, env, ctx) {
    if (!env.DB) return;
    await ensureDatabaseSchema(env.DB);
    const { results: clients } = await env.DB.prepare(
      "SELECT * FROM clients WHERE google_refresh_token IS NOT NULL AND google_refresh_token != '' AND google_location_name IS NOT NULL AND google_location_name != ''"
    ).all();

    for (const client of clients) {
      try {
        await syncClientReviews(env, client);
      } catch (err) {
        console.error(`Cron sync error for client ${client.id}:`, err.message);
      }
    }
  }
};

// ============================================================================
// BASE DE DONNÉES D1 : CRÉATION ET MIGRATION COMPLÈTE DES COLONNES
// ============================================================================
async function ensureDatabaseSchema(db) {
  await db.batch([
    db.prepare(`
      CREATE TABLE IF NOT EXISTS admin_settings (
        key TEXT PRIMARY KEY,
        value TEXT
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS clients (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        business_name TEXT NOT NULL DEFAULT '',
        owner_name TEXT,
        email TEXT,
        phone TEXT,
        city TEXT,
        region TEXT,
        category TEXT,
        website_url TEXT,
        booking_calendar_url TEXT,
        booking_notes TEXT,
        logo_url TEXT,
        gallery_urls TEXT,
        heyzine_page INTEGER DEFAULT 1,
        youtube_video_id TEXT,
        google_place_id TEXT,
        google_account_name TEXT,
        google_location_name TEXT,
        google_refresh_token TEXT,
        google_access_token TEXT,
        google_token_expiry INTEGER DEFAULT 0,
        status TEXT DEFAULT 'actif',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS google_reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id INTEGER NOT NULL,
        google_review_id TEXT UNIQUE,
        reviewer_name TEXT,
        star_rating INTEGER DEFAULT 5,
        comment TEXT,
        reply_text TEXT,
        replied_at DATETIME,
        review_created_at TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS google_posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id INTEGER NOT NULL,
        summary TEXT NOT NULL,
        media_url TEXT,
        cta_type TEXT DEFAULT 'LEARN_MORE',
        cta_url TEXT,
        google_post_name TEXT,
        status TEXT DEFAULT 'published',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS heyzine_leads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id INTEGER,
        prospect_name TEXT,
        prospect_phone TEXT,
        prospect_email TEXT,
        source TEXT DEFAULT 'Revue Heyzine',
        status TEXT DEFAULT 'nouveau',
        notes TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS appointments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id INTEGER NOT NULL,
        prospect_name TEXT NOT NULL,
        prospect_phone TEXT,
        prospect_email TEXT,
        appointment_date TEXT NOT NULL,
        appointment_time TEXT NOT NULL,
        status TEXT DEFAULT 'confirmé',
        notes TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)
  ]);

  // Ajout automatique de toute colonne manquante si une table existait déjà
  const alterStatements = [
    "ALTER TABLE clients ADD COLUMN business_name TEXT DEFAULT ''",
    "ALTER TABLE clients ADD COLUMN owner_name TEXT",
    "ALTER TABLE clients ADD COLUMN email TEXT",
    "ALTER TABLE clients ADD COLUMN phone TEXT",
    "ALTER TABLE clients ADD COLUMN city TEXT",
    "ALTER TABLE clients ADD COLUMN region TEXT",
    "ALTER TABLE clients ADD COLUMN category TEXT",
    "ALTER TABLE clients ADD COLUMN website_url TEXT",
    "ALTER TABLE clients ADD COLUMN booking_calendar_url TEXT",
    "ALTER TABLE clients ADD COLUMN booking_notes TEXT",
    "ALTER TABLE clients ADD COLUMN logo_url TEXT",
    "ALTER TABLE clients ADD COLUMN gallery_urls TEXT",
    "ALTER TABLE clients ADD COLUMN heyzine_page INTEGER DEFAULT 1",
    "ALTER TABLE clients ADD COLUMN youtube_video_id TEXT",
    "ALTER TABLE clients ADD COLUMN google_place_id TEXT",
    "ALTER TABLE clients ADD COLUMN google_account_name TEXT",
    "ALTER TABLE clients ADD COLUMN google_location_name TEXT",
    "ALTER TABLE clients ADD COLUMN google_refresh_token TEXT",
    "ALTER TABLE clients ADD COLUMN google_access_token TEXT",
    "ALTER TABLE clients ADD COLUMN google_token_expiry INTEGER DEFAULT 0",
    "ALTER TABLE clients ADD COLUMN status TEXT DEFAULT 'actif'",
    "ALTER TABLE google_reviews ADD COLUMN reply_text TEXT",
    "ALTER TABLE google_reviews ADD COLUMN replied_at DATETIME",
    "ALTER TABLE google_reviews ADD COLUMN review_created_at TEXT",
    "ALTER TABLE appointments ADD COLUMN prospect_phone TEXT",
    "ALTER TABLE appointments ADD COLUMN prospect_email TEXT",
    "ALTER TABLE appointments ADD COLUMN status TEXT DEFAULT 'confirmé'",
    "ALTER TABLE appointments ADD COLUMN notes TEXT",
    "ALTER TABLE heyzine_leads ADD COLUMN status TEXT DEFAULT 'nouveau'",
    "ALTER TABLE heyzine_leads ADD COLUMN notes TEXT"
  ];

  for (const sql of alterStatements) {
    try {
      await db.prepare(sql).run();
    } catch (_) {}
  }

  // Si une ancienne table avait une colonne 'name' au lieu de 'business_name', on copie ses valeurs
  try {
    await db.prepare("UPDATE clients SET business_name = name WHERE (business_name IS NULL OR business_name = '') AND name IS NOT NULL").run();
  } catch (_) {}
}

// ============================================================================
// AUTHENTIFICATION & SÉCURITÉ
// ============================================================================
async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function getTeamPasswordHash(db) {
  const row = await db.prepare("SELECT value FROM admin_settings WHERE key = 'team_password_hash'").first();
  return row ? row.value : null;
}

async function getSessionToken(env) {
  const master = env.MASTER_ADMIN_PASSWORD || 'PontDigital2026!';
  return await sha256Hex(`pd_session_salt_${master}`);
}

async function verifySession(request, env) {
  const cookieHeader = request.headers.get('Cookie') || '';
  const match = cookieHeader.match(/pd_admin_session=([^;]+)/);
  if (!match) return false;
  const expected = await getSessionToken(env);
  return match[1] === expected;
}

async function handleLogin(request, env) {
  const formData = await request.formData();
  const password = (formData.get('password') || '').toString().trim();
  const master = env.MASTER_ADMIN_PASSWORD || '';
  const teamHash = await getTeamPasswordHash(env.DB);
  const inputHash = await sha256Hex(password);

  const isMasterValid = master && password === master;
  const isTeamValid = teamHash && inputHash === teamHash;

  if (!isMasterValid && !isTeamValid) {
    return new Response(renderLoginHTML('Mot de passe invalide. Vérifie ton accès Super Admin ou équipe.'), {
      status: 401,
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }

  const token = await getSessionToken(env);
  return new Response(null, {
    status: 302,
    headers: {
      'Location': '/',
      'Set-Cookie': `pd_admin_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`
    }
  });
}

// ============================================================================
// GOOGLE BUSINESS PROFILE OAUTH 2.0
// ============================================================================
function handleGoogleOAuthStart(url, env) {
  const clientId = url.searchParams.get('client_id');
  if (!clientId) return new Response('client_id manquant', { status: 400 });
  if (!env.GOOGLE_CLIENT_ID) {
    return renderErrorHTML('Variable manquante', 'La variable GOOGLE_CLIENT_ID est manquante dans Cloudflare.');
  }

  const redirectUri = `${url.origin}/oauth/google/callback`;
  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'https://www.googleapis.com/auth/business.manage');
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');
  authUrl.searchParams.set('state', clientId);

  return Response.redirect(authUrl.toString(), 302);
}

async function handleGoogleOAuthCallback(url, env) {
  const code = url.searchParams.get('code');
  const clientId = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  if (error) return renderErrorHTML('Erreur Google OAuth', error);
  if (!code || !clientId) return renderErrorHTML('Paramètres OAuth incomplets', 'Code ou client_id manquant.');

  const redirectUri = `${url.origin}/oauth/google/callback`;
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code'
    })
  });

  const tokenData = await tokenRes.json();
  if (!tokenRes.ok || !tokenData.access_token) {
    return renderErrorHTML('Échec échange token Google', JSON.stringify(tokenData, null, 2));
  }

  const expiry = Date.now() + ((tokenData.expires_in || 3500) * 1000);
  if (tokenData.refresh_token) {
    await env.DB.prepare(
      "UPDATE clients SET google_access_token = ?, google_refresh_token = ?, google_token_expiry = ? WHERE id = ?"
    ).bind(tokenData.access_token, tokenData.refresh_token, expiry, clientId).run();
  } else {
    await env.DB.prepare(
      "UPDATE clients SET google_access_token = ?, google_token_expiry = ? WHERE id = ?"
    ).bind(tokenData.access_token, expiry, clientId).run();
  }

  const locations = [];
  try {
    const accRes = await fetch('https://mybusinessaccountmanagement.googleapis.com/v1/accounts', {
      headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
    });
    const accData = await accRes.json();
    const accounts = accData.accounts || [];

    for (const acc of accounts) {
      const locRes = await fetch(
        `https://mybusinessbusinessinformation.googleapis.com/v1/${acc.name}/locations?readMask=name,title,storefrontAddress,metadata`,
        { headers: { 'Authorization': `Bearer ${tokenData.access_token}` } }
      );
      const locData = await locRes.json();
      for (const loc of (locData.locations || [])) {
        locations.push({
          accountName: acc.name,
          accountDisplay: acc.accountName || acc.name,
          locationName: loc.name,
          title: loc.title || loc.name,
          placeId: loc.metadata?.placeId || ''
        });
      }
    }
  } catch (e) {
    console.error('Erreur récupération fiches GBP:', e.message);
  }

  if (locations.length === 1) {
    const only = locations[0];
    await env.DB.prepare(
      "UPDATE clients SET google_account_name = ?, google_location_name = ?, google_place_id = COALESCE(NULLIF(?, ''), google_place_id) WHERE id = ?"
    ).bind(only.accountName, only.locationName, only.placeId, clientId).run();
    return Response.redirect(`${url.origin}/?gbp_connected=1`, 302);
  }

  return new Response(renderSelectLocationHTML(clientId, locations), {
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

async function handleGoogleSelectLocation(request, env) {
  const formData = await request.formData();
  const clientId = formData.get('client_id');
  const packed = (formData.get('location_packed') || '').toString();
  const [accountName, locationName, placeId] = packed.split('|||');

  if (clientId && accountName && locationName) {
    await env.DB.prepare(
      "UPDATE clients SET google_account_name = ?, google_location_name = ?, google_place_id = COALESCE(NULLIF(?, ''), google_place_id) WHERE id = ?"
    ).bind(accountName, locationName, placeId || '', clientId).run();
  }

  const url = new URL(request.url);
  return Response.redirect(`${url.origin}/?gbp_connected=1`, 302);
}

async function getValidGoogleAccessToken(env, client) {
  if (client.google_access_token && client.google_token_expiry > Date.now() + 60000) {
    return client.google_access_token;
  }
  if (!client.google_refresh_token) {
    throw new Error('Aucun refresh_token Google enregistré pour ce client.');
  }
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: client.google_refresh_token,
      grant_type: 'refresh_token'
    })
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(`Impossible de rafraîchir le token Google : ${JSON.stringify(data)}`);
  }
  const expiry = Date.now() + ((data.expires_in || 3500) * 1000);
  await env.DB.prepare(
    "UPDATE clients SET google_access_token = ?, google_token_expiry = ? WHERE id = ?"
  ).bind(data.access_token, expiry, client.id).run();
  return data.access_token;
}

async function syncClientReviews(env, client) {
  const token = await getValidGoogleAccessToken(env, client);
  const parent = `${client.google_account_name}/${client.google_location_name}`;
  const res = await fetch(`https://mybusiness.googleapis.com/v4/${parent}/reviews`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error?.message || JSON.stringify(data));
  }

  const ratingMap = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
  const reviews = data.reviews || [];
  let count = 0;

  for (const r of reviews) {
    const revId = r.reviewId || r.name;
    const stars = ratingMap[r.starRating] || 5;
    const replyText = r.reviewReply?.comment || null;
    const repliedAt = r.reviewReply?.updateTime || null;

    await env.DB.prepare(`
      INSERT INTO google_reviews (client_id, google_review_id, reviewer_name, star_rating, comment, reply_text, replied_at, review_created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(google_review_id) DO UPDATE SET
        star_rating = excluded.star_rating,
        comment = excluded.comment,
        reply_text = COALESCE(excluded.reply_text, google_reviews.reply_text),
        replied_at = COALESCE(excluded.replied_at, google_reviews.replied_at)
    `).bind(
      client.id,
      revId,
      r.reviewer?.displayName || 'Client Google',
      stars,
      r.comment || '',
      replyText,
      repliedAt,
      r.createTime || new Date().toISOString()
    ).run();
    count++;
  }
  return count;
}

// ============================================================================
// API JSON INTERNE DU TABLEAU DE BORD
// ============================================================================
async function handleApiRequest(request, env, path, url) {
  try {
    if (path === '/api/clients' && request.method === 'POST') {
      const b = await request.json();
      const galleryJson = JSON.stringify((b.gallery_urls || []).filter(Boolean).slice(0, 5));
      await env.DB.prepare(`
        INSERT INTO clients (
          business_name, owner_name, email, phone, city, region, category,
          website_url, booking_calendar_url, booking_notes, logo_url, gallery_urls,
          heyzine_page, youtube_video_id, google_place_id, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        b.business_name, b.owner_name || '', b.email || '', b.phone || '',
        b.city || '', b.region || 'Rive-Nord / Rive-Sud', b.category || '',
        b.website_url || '', b.booking_calendar_url || '', b.booking_notes || '',
        b.logo_url || '', galleryJson,
        Number(b.heyzine_page || 1), b.youtube_video_id || '', b.google_place_id || '',
        b.status || 'actif'
      ).run();
      return jsonOK({ message: 'Client ajouté avec succès.' });
    }

    if (path === '/api/clients/update' && request.method === 'POST') {
      const b = await request.json();
      const galleryJson = JSON.stringify((b.gallery_urls || []).filter(Boolean).slice(0, 5));
      await env.DB.prepare(`
        UPDATE clients SET
          business_name = ?, owner_name = ?, email = ?, phone = ?, city = ?, region = ?,
          category = ?, website_url = ?, booking_calendar_url = ?, booking_notes = ?,
          logo_url = ?, gallery_urls = ?, heyzine_page = ?, youtube_video_id = ?,
          google_place_id = ?, status = ?
        WHERE id = ?
      `).bind(
        b.business_name, b.owner_name || '', b.email || '', b.phone || '',
        b.city || '', b.region || '', b.category || '', b.website_url || '',
        b.booking_calendar_url || '', b.booking_notes || '', b.logo_url || '',
        galleryJson, Number(b.heyzine_page || 1), b.youtube_video_id || '',
        b.google_place_id || '', b.status || 'actif', b.id
      ).run();
      return jsonOK({ message: 'Fiche client mise à jour.' });
    }

    if (path === '/api/clients/delete' && request.method === 'POST') {
      const { id } = await request.json();
      await env.DB.prepare("DELETE FROM clients WHERE id = ?").bind(id).run();
      return jsonOK({ message: 'Client supprimé.' });
    }

    if (path === '/api/gbp/sync-reviews' && request.method === 'POST') {
      const { client_id } = await request.json();
      const client = await env.DB.prepare("SELECT * FROM clients WHERE id = ?").bind(client_id).first();
      if (!client || !client.google_location_name) {
        return jsonErr('Connecte d’abord la fiche Google Business Profile de ce client.');
      }
      const count = await syncClientReviews(env, client);
      return jsonOK({ message: `${count} avis synchronisé(s) depuis Google.` });
    }

    if (path === '/api/gbp/reply-review' && request.method === 'POST') {
      const { review_id, reply_text } = await request.json();
      const rev = await env.DB.prepare("SELECT * FROM google_reviews WHERE id = ?").bind(review_id).first();
      if (!rev) return jsonErr('Avis introuvable.');
      const client = await env.DB.prepare("SELECT * FROM clients WHERE id = ?").bind(rev.client_id).first();
      if (!client || !client.google_location_name) return jsonErr('Fiche Google non connectée.');

      const token = await getValidGoogleAccessToken(env, client);
      const endpoint = `https://mybusiness.googleapis.com/v4/${client.google_account_name}/${client.google_location_name}/reviews/${rev.google_review_id}/reply`;
      const res = await fetch(endpoint, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ comment: reply_text })
      });
      if (!res.ok) {
        const errData = await res.json();
        return jsonErr(`Erreur Google API : ${errData.error?.message || JSON.stringify(errData)}`);
      }
      await env.DB.prepare(
        "UPDATE google_reviews SET reply_text = ?, replied_at = CURRENT_TIMESTAMP WHERE id = ?"
      ).bind(reply_text, review_id).run();
      return jsonOK({ message: 'Réponse publiée sur Google !' });
    }

    if (path === '/api/gbp/create-post' && request.method === 'POST') {
      const { client_id, summary, media_url, cta_type, cta_url } = await request.json();
      const client = await env.DB.prepare("SELECT * FROM clients WHERE id = ?").bind(client_id).first();
      if (!client || !client.google_location_name) {
        return jsonErr('Connecte d’abord la fiche Google Business Profile de ce client.');
      }

      const token = await getValidGoogleAccessToken(env, client);
      const payload = {
        languageCode: 'fr-CA',
        summary,
        topicType: 'STANDARD'
      };
      if (media_url) {
        payload.media = [{ mediaFormat: 'PHOTO', sourceUrl: media_url }];
      }
      if (cta_type && cta_url) {
        payload.callToAction = { actionType: cta_type, url: cta_url };
      }

      const res = await fetch(
        `https://mybusiness.googleapis.com/v4/${client.google_account_name}/${client.google_location_name}/localPosts`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload)
        }
      );
      const data = await res.json();
      if (!res.ok) {
        return jsonErr(`Erreur publication Google Post : ${data.error?.message || JSON.stringify(data)}`);
      }

      await env.DB.prepare(
        "INSERT INTO google_posts (client_id, summary, media_url, cta_type, cta_url, google_post_name) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(client_id, summary, media_url || '', cta_type || '', cta_url || '', data.name || '').run();

      return jsonOK({ message: 'Google Post publié avec succès !' });
    }

    if (path === '/api/ai/generate' && request.method === 'POST') {
      const { mode, business_name, category, city, context_text } = await request.json();
      if (!env.OPENROUTER_API_KEY) {
        return jsonErr('Ajoute la variable OPENROUTER_API_KEY dans Cloudflare pour activer NyXia.');
      }

      const systemPrompt = mode === 'reply'
        ? "Tu es NyXia, assistante de visibilité locale de l'agence Pont Digital au Québec. Rédige une réponse chaleureuse, professionnelle, authentique et optimisée SEO local (en français du Québec, 2 à 4 phrases maximum) à cet avis client Google. Aucune formule robotique."
        : "Tu es NyXia, experte en marketing local au Québec pour Pont Digital. Rédige un Google Post captivant (100 à 180 mots, français du Québec, avec 1 ou 2 émojis sobres et un appel à l'action clair vers la prise de rendez-vous) pour mettre en valeur cette entreprise locale.";

      const userPrompt = `Entreprise : ${business_name} (${category || 'commerce local'}) à ${city || 'Québec'}.\nContexte : ${context_text}`;

      const aiRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'meta-llama/llama-3.3-70b-instruct',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          temperature: 0.7
        })
      });
      const aiData = await aiRes.json();
      const generated = aiData.choices?.[0]?.message?.content?.trim();
      if (!generated) {
        return jsonErr(`Erreur OpenRouter : ${JSON.stringify(aiData)}`);
      }
      return jsonOK({ text: generated });
    }

    if (path === '/api/appointments' && request.method === 'POST') {
      const b = await request.json();
      await env.DB.prepare(`
        INSERT INTO appointments (client_id, prospect_name, prospect_phone, prospect_email, appointment_date, appointment_time, status, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        b.client_id, b.prospect_name, b.prospect_phone || '', b.prospect_email || '',
        b.appointment_date, b.appointment_time, b.status || 'confirmé', b.notes || ''
      ).run();

      const client = await env.DB.prepare("SELECT business_name FROM clients WHERE id = ?").bind(b.client_id).first();
      await sendSetterSms(
        env,
        `Pont Digital — Nouveau RDV booké pour ${client?.business_name || 'Client'} : ${b.prospect_name} (${b.prospect_phone || 'sans tél'}) le ${b.appointment_date} à ${b.appointment_time}.`
      );
      return jsonOK({ message: 'Rendez-vous enregistré dans le journal.' });
    }

    if (path === '/api/appointments/delete' && request.method === 'POST') {
      const { id } = await request.json();
      await env.DB.prepare("DELETE FROM appointments WHERE id = ?").bind(id).run();
      return jsonOK({ message: 'Rendez-vous retiré.' });
    }

    if (path === '/api/leads/status' && request.method === 'POST') {
      const { id, status } = await request.json();
      await env.DB.prepare("UPDATE heyzine_leads SET status = ? WHERE id = ?").bind(status, id).run();
      return jsonOK({ message: 'Statut du prospect mis à jour.' });
    }

    if (path === '/api/sms/test' && request.method === 'POST') {
      const sent = await sendSetterSms(env, 'Pont Digital : Test réussi ! Ton alerte SMS Appointment Setter est active.');
      if (!sent.ok) return jsonErr(sent.error);
      return jsonOK({ message: 'SMS de test envoyé sur ton téléphone !' });
    }

    if (path === '/api/settings/team-password' && request.method === 'POST') {
      const { new_password } = await request.json();
      if (!new_password || new_password.length < 6) {
        return jsonErr('Le mot de passe équipe doit contenir au moins 6 caractères.');
      }
      const hash = await sha256Hex(new_password.trim());
      await env.DB.prepare(
        "INSERT INTO admin_settings (key, value) VALUES ('team_password_hash', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      ).bind(hash).run();
      return jsonOK({ message: 'Mot de passe équipe enregistré et chiffré.' });
    }

    return jsonErr('Route API inconnue.', 404);
  } catch (err) {
    return jsonErr(err.message, 500);
  }
}

async function sendSetterSms(env, message) {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_FROM_NUMBER || !env.AGENCY_ALERT_PHONE) {
    return { ok: false, error: 'Variables Twilio ou AGENCY_ALERT_PHONE non configurées dans Cloudflare.' };
  }
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`,
    {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        To: env.AGENCY_ALERT_PHONE,
        From: env.TWILIO_FROM_NUMBER,
        Body: message
      })
    }
  );
  if (!res.ok) {
    const err = await res.text();
    return { ok: false, error: `Twilio : ${err}` };
  }
  return { ok: true };
}

function jsonOK(data = {}) {
  return new Response(JSON.stringify({ ok: true, ...data }), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

function jsonErr(error, status = 400) {
  return new Response(JSON.stringify({ ok: false, error }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ============================================================================
// INTERFACES HTML (/images/FavIcon.png dans l'onglet + /images/NyXia.png visuel)
// ============================================================================
function renderHeadAssets(title) {
  return `
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(title)}</title>
  <link rel="icon" type="image/png" href="${FAVICON_URL}">
  <link rel="apple-touch-icon" href="${FAVICON_URL}">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@600;700&family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="${CSS_URL}">
  <style>
    :root {
      --bg-deep:#060a18; --bg-card:#0e1430; --bg-card-hover:#141b3d;
      --primary:#7B5CFF; --secondary:#5A6CFF; --primary-light:#a78bfa; --blue:#4FA3FF;
      --primary-glow:rgba(123,92,255,.35); --gold:#F4C842; --green:#34d399;
      --text:#f1f0ff; --text-secondary:#b9b3d6; --text-muted:#7c73a0;
      --border:rgba(123,92,255,.18); --radius:18px; --radius-sm:11px;
      --shadow-glow:0 16px 48px rgba(123,92,255,.16);
      --transition:.3s cubic-bezier(.4,0,.2,1);
    }
    *,*::before,*::after { margin:0; padding:0; box-sizing:border-box; }
    body { font-family:Outfit,-apple-system,BlinkMacSystemFont,sans-serif; background:var(--bg-deep); color:var(--text); line-height:1.6; min-height:100vh; overflow-x:hidden; }
    a { color:var(--primary-light); text-decoration:none; }
    button { cursor:pointer; font-family:inherit; border:none; outline:none; color:inherit; }
    .display { font-family:'Cormorant Garamond',Georgia,serif; font-weight:700; letter-spacing:.3px; }
    #starry-canvas { position:fixed; inset:0; z-index:0; pointer-events:none; }
    .aura {
      position:fixed; inset:0; z-index:0; pointer-events:none;
      background:
        radial-gradient(60% 40% at 80% 6%,rgba(123,92,255,.2),transparent 60%),
        radial-gradient(50% 40% at 10% 24%,rgba(79,163,255,.12),transparent 60%),
        radial-gradient(70% 50% at 50% 112%,rgba(244,200,66,.06),transparent 60%);
    }
    .site-header {
      position:sticky; top:0; z-index:20; display:flex; align-items:center; justify-content:space-between; gap:16px;
      padding:14px clamp(16px,4vw,34px); border-bottom:1px solid rgba(123,92,255,.14);
      backdrop-filter:blur(14px); background:rgba(6,10,24,.72);
    }
    .brand { display:flex; align-items:center; gap:12px; color:#fff; font-weight:600; }
    .brand img { width:44px; height:44px; border-radius:50%; object-fit:cover; border:2px solid rgba(123,92,255,.55); box-shadow:0 0 22px rgba(123,92,255,.45); }
    .brand-name { display:flex; flex-direction:column; line-height:1.1; }
    .brand-name b { font-size:1.05rem; font-weight:700; }
    .brand-name span { font-size:.72rem; color:var(--text-muted); letter-spacing:.5px; text-transform:uppercase; }
    .header-right { display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
    .btn-primary {
      padding:10px 22px; border-radius:var(--radius-sm);
      background:linear-gradient(135deg,var(--primary),var(--secondary));
      color:#fff; font-size:.875rem; font-weight:600; white-space:nowrap;
      box-shadow:0 4px 16px var(--primary-glow); transition:transform var(--transition),box-shadow var(--transition);
    }
    .btn-primary:hover { transform:translateY(-1px); box-shadow:0 6px 26px var(--primary-glow); color:#fff; }
    .btn-ghost {
      padding:10px 22px; border-radius:var(--radius-sm); white-space:nowrap;
      background:rgba(123,92,255,.12); border:1px solid var(--border);
      color:var(--text); font-size:.875rem; font-weight:600; transition:all var(--transition);
    }
    .btn-ghost:hover { border-color:var(--primary); background:rgba(123,92,255,.22); color:#fff; }
    .admin-wrap { position: relative; z-index: 1; max-width: 1360px; margin: 0 auto; padding: 28px clamp(16px, 3vw, 32px) 64px; }
    .admin-card { background: rgba(14, 20, 48, 0.78); border: 1px solid var(--border); border-radius: var(--radius); padding: 24px; backdrop-filter: blur(14px); box-shadow: var(--shadow-glow); margin-bottom: 24px; }
    .kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .kpi-box { background: linear-gradient(145deg, rgba(14, 20, 48, 0.9), rgba(20, 27, 61, 0.6)); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px; }
    .kpi-label { font-size: .78rem; text-transform: uppercase; letter-spacing: .8px; color: var(--text-muted); }
    .kpi-val { font-family: 'Cormorant Garamond', serif; font-size: 2.3rem; font-weight: 700; color: var(--gold); line-height: 1.1; margin-top: 6px; }
    .field-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; }
    .field label { display: block; font-size: .78rem; color: var(--text-secondary); margin-bottom: 5px; font-weight: 500; }
    .field input, .field select, .field textarea {
      width: 100%; padding: 10px 13px; border-radius: var(--radius-sm);
      background: rgba(6, 10, 24, 0.85); border: 1px solid var(--border);
      color: var(--text); font-family: inherit; font-size: .9rem;
    }
    .field input:focus, .field select:focus, .field textarea:focus { outline: none; border-color: var(--primary); box-shadow: 0 0 0 3px rgba(123, 92, 255, .2); }
    .table-scroll { overflow-x: auto; }
    table.pd-table { width: 100%; border-collapse: collapse; font-size: .88rem; }
    table.pd-table th { text-align: left; padding: 12px 14px; color: var(--gold); font-size: .75rem; text-transform: uppercase; letter-spacing: .7px; border-bottom: 1px solid var(--border); }
    table.pd-table td { padding: 14px; border-bottom: 1px solid rgba(123, 92, 255, .1); vertical-align: top; }
    table.pd-table tr:hover td { background: rgba(123, 92, 255, .05); }
    .pill { display: inline-flex; align-items: center; gap: 6px; padding: 4px 11px; border-radius: 50px; font-size: .75rem; font-weight: 600; }
    .pill-ok { background: rgba(52, 211, 153, .14); color: var(--green); border: 1px solid rgba(52, 211, 153, .35); }
    .pill-warn { background: rgba(244, 200, 66, .12); color: var(--gold); border: 1px solid rgba(244, 200, 66, .35); }
    .pill-muted { background: rgba(124, 115, 160, .15); color: var(--text-secondary); border: 1px solid var(--border); }
    .btn-sm { padding: 7px 13px; border-radius: 9px; font-size: .78rem; font-weight: 600; display: inline-flex; align-items: center; gap: 6px; transition: all .2s; }
    .btn-gold { background: rgba(244, 200, 66, .14); color: var(--gold); border: 1px solid rgba(244, 200, 66, .45); }
    .btn-gold:hover { background: rgba(244, 200, 66, .26); color: #fff; }
    .btn-danger { background: rgba(248, 113, 113, .12); color: #fca5a5; border: 1px solid rgba(248, 113, 113, .3); }
    .btn-danger:hover { background: rgba(248, 113, 113, .25); color: #fff; }
    .actions-stack { display: flex; flex-wrap: wrap; gap: 6px; }
    .modal-backdrop { position: fixed; inset: 0; z-index: 60; background: rgba(6, 10, 24, .82); backdrop-filter: blur(8px); display: none; align-items: center; justify-content: center; padding: 20px; }
    .modal-backdrop.open { display: flex; }
    .modal-box { width: 100%; max-width: 760px; max-height: 90vh; overflow-y: auto; background: var(--bg-card); border: 1px solid rgba(123, 92, 255, .4); border-radius: var(--radius); padding: 26px; box-shadow: 0 24px 64px rgba(0,0,0,.65); }
    .toast { position: fixed; bottom: 24px; right: 24px; z-index: 80; padding: 14px 20px; border-radius: 12px; background: #141b3d; border: 1px solid var(--gold); color: #fff; font-size: .9rem; box-shadow: 0 12px 32px rgba(0,0,0,.5); display: none; }
  </style>`;
}

function renderBackgroundAndScripts() {
  return `
  <canvas id="starry-canvas"></canvas>
  <div class="aura"></div>
  <script src="${STARRY_JS_URL}" defer></script>`;
}

function renderErrorHTML(title, details) {
  return new Response(`<!DOCTYPE html>
<html lang="fr">
<head>${renderHeadAssets(title)}</head>
<body>
  ${renderBackgroundAndScripts()}
  <main style="position:relative;z-index:1;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;">
    <div class="admin-card" style="width:100%;max-width:620px;padding:32px;">
      <h1 class="display" style="font-size:1.8rem;color:var(--gold);margin-bottom:10px;">${esc(title)}</h1>
      <pre style="white-space:pre-wrap;background:rgba(6,10,24,.9);border:1px solid var(--border);padding:14px;border-radius:10px;color:#fecaca;font-size:.82rem;margin-bottom:18px;">${esc(details)}</pre>
      <a href="/" class="btn-primary">Recharger la console</a>
    </div>
  </main>
</body>
</html>`, {
    status: 500,
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

function renderLoginHTML(errorMsg = '') {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  ${renderHeadAssets('Connexion • SuperAdmin Pont Digital')}
</head>
<body>
  ${renderBackgroundAndScripts()}
  <main style="position:relative;z-index:1;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;">
    <div class="admin-card" style="width:100%;max-width:440px;text-align:center;padding:36px 28px;">
      <img src="${NYXIA_AVATAR_URL}" alt="NyXia • Pont Digital" style="width:84px;height:84px;border-radius:50%;margin:0 auto 16px;border:2px solid var(--gold);box-shadow:0 0 30px rgba(244,200,66,.4);object-fit:cover;">
      <span style="font-size:.75rem;letter-spacing:1.5px;text-transform:uppercase;color:var(--gold);font-weight:700;">Agence Pont Digital</span>
      <h1 class="display" style="font-size:2.1rem;margin:6px 0 8px;color:#fff;">Console Super Admin</h1>
      <p style="color:var(--text-secondary);font-size:.9rem;margin-bottom:24px;">Accès réservé à la direction et à l'équipe Appointment Setting.</p>
      ${errorMsg ? `<div style="background:rgba(248,113,113,.15);border:1px solid rgba(248,113,113,.4);color:#fecaca;padding:10px 14px;border-radius:10px;font-size:.85rem;margin-bottom:16px;">${esc(errorMsg)}</div>` : ''}
      <form method="POST" action="/login" style="text-align:left;">
        <div class="field" style="margin-bottom:18px;">
          <label for="password">Mot de passe Super Admin ou Équipe</label>
          <input type="password" id="password" name="password" placeholder="••••••••••••" required autofocus>
        </div>
        <button type="submit" class="btn-primary" style="width:100%;padding:13px;font-size:.95rem;">Déverrouiller la console</button>
      </form>
    </div>
  </main>
</body>
</html>`;
}

function renderSelectLocationHTML(clientId, locations) {
  const options = locations.map(l => {
    const val = `${l.accountName}|||${l.locationName}|||${l.placeId}`;
    return `<option value="${esc(val)}">${esc(l.title)} (${esc(l.accountDisplay)})</option>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="fr">
<head>
  ${renderHeadAssets('Associer une fiche Google • Pont Digital')}
</head>
<body>
  ${renderBackgroundAndScripts()}
  <main style="position:relative;z-index:1;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;">
    <div class="admin-card" style="width:100%;max-width:520px;padding:32px;">
      <h1 class="display" style="font-size:1.9rem;color:var(--gold);margin-bottom:10px;">Sélectionne la fiche Google Business</h1>
      <p style="color:var(--text-secondary);font-size:.92rem;margin-bottom:20px;">
        ${locations.length > 0
          ? 'Plusieurs fiches sont accessibles sur ce compte Google. Choisis celle à relier à cet entrepreneur :'
          : 'Connexion Google enregistrée, mais aucune fiche Google Business Profile active n’a été détectée sur ce compte (ou l’approbation API Google est encore en attente).'}
      </p>
      ${locations.length > 0 ? `
        <form method="POST" action="/oauth/google/select-location">
          <input type="hidden" name="client_id" value="${esc(clientId)}">
          <div class="field" style="margin-bottom:20px;">
            <label>Fiche d'établissement Google</label>
            <select name="location_packed" required>${options}</select>
          </div>
          <button type="submit" class="btn-primary" style="width:100%;padding:12px;">Associer cette fiche</button>
        </form>
      ` : `<a href="/" class="btn-primary" style="display:inline-block;text-align:center;width:100%;">Retourner au Super Admin</a>`}
    </div>
  </main>
</body>
</html>`;
}

async function renderDashboardHTML(env) {
  const clientsRes = await env.DB.prepare("SELECT * FROM clients ORDER BY id DESC").all();
  const clients = clientsRes.results || [];

  const reviewsRes = await env.DB.prepare(`
    SELECT r.*, c.business_name, c.category, c.city
    FROM google_reviews r
    LEFT JOIN clients c ON c.id = r.client_id
    ORDER BY r.id DESC LIMIT 40
  `).all();
  const reviews = reviewsRes.results || [];

  const apptRes = await env.DB.prepare(`
    SELECT a.*, c.business_name
    FROM appointments a
    LEFT JOIN clients c ON c.id = a.client_id
    ORDER BY a.id DESC LIMIT 30
  `).all();
  const appointments = apptRes.results || [];

  const leadsRes = await env.DB.prepare(`
    SELECT l.*, c.business_name
    FROM heyzine_leads l
    LEFT JOIN clients c ON c.id = l.client_id
    ORDER BY l.id DESC LIMIT 30
  `).all();
  const leads = leadsRes.results || [];

  const gbpConnectedCount = clients.filter(c => c.google_location_name).length;
  const bookingReadyCount = clients.filter(c => c.booking_calendar_url).length;
  const pendingReviewsCount = reviews.filter(r => !r.reply_text).length;

  const clientOptions = clients.map(c => `<option value="${c.id}">${esc(c.business_name || c.name || 'Client #' + c.id)}</option>`).join('');

  const clientsRows = clients.map(c => {
    const bizName = c.business_name || c.name || 'Entreprise';
    const isGbp = Boolean(c.google_location_name);
    const hasCal = Boolean(c.booking_calendar_url);
    let photosCount = 0;
    try { photosCount = JSON.parse(c.gallery_urls || '[]').length; } catch (_) {}

    return `
      <tr>
        <td>
          <div style="display:flex;align-items:center;gap:10px;">
            ${c.logo_url ? `<img src="${esc(c.logo_url)}" alt="" style="width:38px;height:38px;border-radius:10px;object-fit:cover;border:1px solid var(--border);">` : ''}
            <div>
              <strong style="color:#fff;font-size:.96rem;">${esc(bizName)}</strong>
              <div style="font-size:.8rem;color:var(--text-muted);">${esc(c.category || 'Entreprise locale')} • ${esc(c.city || 'Québec')}</div>
              <div style="font-size:.76rem;color:var(--text-secondary);">Page revue #${c.heyzine_page || 1} • ${photosCount} photo(s) galerie</div>
            </div>
          </div>
        </td>
        <td>
          ${hasCal
            ? `<span class="pill pill-ok">● Agenda Google prêt</span>
               <div style="margin-top:6px;"><a href="${esc(c.booking_calendar_url)}" target="_blank" class="btn-sm btn-gold">📅 Ouvrir son agenda setter</a></div>`
            : `<span class="pill pill-warn">○ Lien agenda à ajouter</span>`}
          ${c.booking_notes ? `<div style="font-size:.76rem;color:var(--text-muted);margin-top:5px;max-width:240px;">${esc(c.booking_notes)}</div>` : ''}
        </td>
        <td>
          ${isGbp
            ? `<span class="pill pill-ok">● GBP Actif</span>`
            : `<span class="pill pill-muted">○ Non connecté</span>`}
          <div style="margin-top:6px;">
            <a href="/oauth/google/start?client_id=${c.id}" class="btn-sm btn-ghost">${isGbp ? '↻ Reconnecter GBP' : '🔗 Connecter Google GBP'}</a>
          </div>
        </td>
        <td>
          <div class="actions-stack">
            <button class="btn-sm btn-ghost" onclick='openEditModal(${JSON.stringify(c).replace(/'/g, "&#39;")})'>✏️ Modifier</button>
            ${isGbp ? `<button class="btn-sm btn-gold" onclick="syncReviews(${c.id})">↻ Sync Avis</button>` : ''}
            <button class="btn-sm btn-danger" onclick="deleteClient(${c.id}, '${esc(bizName)}')">🗑️</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  const reviewsRows = reviews.map(r => `
    <tr>
      <td>
        <strong style="color:#fff;">${esc(r.business_name || 'Client')}</strong>
        <div style="font-size:.8rem;color:var(--gold);">${'★'.repeat(r.star_rating || 5)} • ${esc(r.reviewer_name)}</div>
      </td>
      <td style="max-width:340px;color:var(--text-secondary);">${esc(r.comment || '(Avis sans texte)')}</td>
      <td style="min-width:280px;">
        ${r.reply_text
          ? `<div style="font-size:.84rem;color:var(--green);background:rgba(52,211,153,.08);padding:10px;border-radius:10px;border:1px solid rgba(52,211,153,.25);">${esc(r.reply_text)}</div>`
          : `<textarea id="reply-box-${r.id}" rows="2" placeholder="Écris ou génère une réponse avec NyXia..." style="width:100%;padding:8px;border-radius:8px;background:rgba(6,10,24,.8);border:1px solid var(--border);color:#fff;font-size:.84rem;margin-bottom:6px;"></textarea>
             <div class="actions-stack">
               <button class="btn-sm btn-gold" onclick="generateAiReply(${r.id}, '${esc(r.business_name)}', '${esc(r.category)}', '${esc(r.city)}', \`${esc(r.comment)}\`)">✨ NyXia</button>
               <button class="btn-sm btn-primary" onclick="sendReviewReply(${r.id})">Publier</button>
             </div>`}
      </td>
    </tr>
  `).join('');

  const apptRows = appointments.map(a => `
    <tr>
      <td><strong style="color:#fff;">${esc(a.business_name || 'Client')}</strong></td>
      <td>${esc(a.prospect_name)}<div style="font-size:.78rem;color:var(--text-muted);">${esc(a.prospect_phone)} ${a.prospect_email ? '• ' + esc(a.prospect_email) : ''}</div></td>
      <td><span class="pill pill-ok">📅 ${esc(a.appointment_date)} à ${esc(a.appointment_time)}</span></td>
      <td style="font-size:.82rem;color:var(--text-secondary);">${esc(a.notes || '')}</td>
      <td><button class="btn-sm btn-danger" onclick="deleteAppointment(${a.id})">✕</button></td>
    </tr>
  `).join('');

  const leadsRows = leads.map(l => `
    <tr>
      <td><strong style="color:#fff;">${esc(l.prospect_name || 'Prospect')}</strong><div style="font-size:.78rem;color:var(--text-muted);">${esc(l.prospect_phone)} • ${esc(l.prospect_email)}</div></td>
      <td>${esc(l.business_name || 'Revue générale')}</td>
      <td><span class="pill pill-warn">${esc(l.status)}</span></td>
      <td style="font-size:.82rem;color:var(--text-secondary);">${esc(l.notes || '')}</td>
    </tr>
  `).join('');

  return `<!DOCTYPE html>
<html lang="fr">
<head>
  ${renderHeadAssets('SuperAdmin • Pont Digital')}
</head>
<body>
  ${renderBackgroundAndScripts()}

  <header class="site-header">
    <a href="/" class="brand">
      <img src="${NYXIA_AVATAR_URL}" alt="NyXia • Pont Digital">
      <div class="brand-name">
        <b>PONT DIGITAL • SUPER ADMIN</b>
        <span>Gestion Agence, GBP & Appointment Setting</span>
      </div>
    </a>
    <div class="header-right">
      <button class="btn-ghost" onclick="testSms()">📱 Tester Alerte SMS Setter</button>
      <a href="/logout" class="btn-primary">Déconnexion</a>
    </div>
  </header>

  <main class="admin-wrap">
    <div class="kpi-grid">
      <div class="kpi-box">
        <div class="kpi-label">Entrepreneurs actifs</div>
        <div class="kpi-val">${clients.length}</div>
      </div>
      <div class="kpi-box">
        <div class="kpi-label">Agendas Setting prêts</div>
        <div class="kpi-val">${bookingReadyCount} / ${clients.length}</div>
      </div>
      <div class="kpi-box">
        <div class="kpi-label">Fiches Google connectées</div>
        <div class="kpi-val">${gbpConnectedCount} / ${clients.length}</div>
      </div>
      <div class="kpi-box">
        <div class="kpi-label">Avis en attente de réponse</div>
        <div class="kpi-val">${pendingReviewsCount}</div>
      </div>
    </div>

    <section class="admin-card">
      <h2 class="display" style="font-size:1.75rem;color:var(--gold);margin-bottom:14px;">+ Ajouter un entrepreneur au réseau Pont Digital</h2>
      <form id="add-client-form" onsubmit="submitNewClient(event)">
        <div class="field-grid">
          <div class="field"><label>Nom de l'entreprise *</label><input name="business_name" required placeholder="Ex: Clinique Harmonie"></div>
          <div class="field"><label>Propriétaire / Contact</label><input name="owner_name" placeholder="Prénom Nom"></div>
          <div class="field"><label>Ville</label><input name="city" placeholder="Ex: Terrebonne / Longueuil"></div>
          <div class="field"><label>Région</label><input name="region" value="Rive-Nord / Rive-Sud"></div>
          <div class="field"><label>Catégorie d'activité</label><input name="category" placeholder="Ex: Massothérapie, Rénovation..."></div>
          <div class="field"><label>Téléphone</label><input name="phone" placeholder="514-000-0000"></div>
          <div class="field"><label>Courriel</label><input type="email" name="email" placeholder="contact@entreprise.ca"></div>
          <div class="field"><label>Site web</label><input name="website_url" placeholder="https://..."></div>
          <div class="field"><label>Lien Prise de RDV Google Workspace (Setter)</label><input name="booking_calendar_url" placeholder="https://calendar.app.google/..."></div>
          <div class="field"><label>Page dans la revue Heyzine</label><input type="number" name="heyzine_page" value="1" min="1"></div>
          <div class="field"><label>ID Vidéo YouTube (ex: dQw4w9WgXcQ)</label><input name="youtube_video_id" placeholder="ID vidéo uniquement"></div>
          <div class="field"><label>URL Logo de l'entreprise</label><input name="logo_url" placeholder="https://..."></div>
        </div>
        <div class="field-grid" style="margin-top:14px;">
          <div class="field"><label>Consignes pour les setters (script / critères qualification)</label><input name="booking_notes" placeholder="Ex: RDV découverte 20 min, secteur Rive-Nord uniquement"></div>
          <div class="field"><label>Photos galerie (jusqu'à 5 URLs séparées par une virgule)</label><input name="gallery_urls" placeholder="https://img1.jpg, https://img2.jpg"></div>
        </div>
        <div style="margin-top:16px;">
          <button type="submit" class="btn-primary">Enregistrer l'entrepreneur</button>
        </div>
      </form>
    </section>

    <section class="admin-card">
      <h2 class="display" style="font-size:1.75rem;color:#fff;margin-bottom:14px;">Répertoire des Entrepreneurs, Agendas & Fiches Google</h2>
      <div class="table-scroll">
        <table class="pd-table">
          <thead>
            <tr>
              <th>Entreprise & Médias</th>
              <th>Appointment Setting (Google Agenda)</th>
              <th>Google Business Profile</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${clientsRows || '<tr><td colspan="4" style="color:var(--text-muted);text-align:center;padding:24px;">Aucun entrepreneur enregistré pour le moment.</td></tr>'}
          </tbody>
        </table>
      </div>
    </section>

    <section class="admin-card">
      <h2 class="display" style="font-size:1.75rem;color:var(--gold);margin-bottom:14px;">Journal Appointment Setting • Rendez-vous bookés</h2>
      <form onsubmit="submitAppointment(event)" style="margin-bottom:20px;padding-bottom:18px;border-bottom:1px solid var(--border);">
        <div class="field-grid">
          <div class="field"><label>Entreprise cliente *</label><select name="client_id" required>${clientOptions}</select></div>
          <div class="field"><label>Nom du prospect *</label><input name="prospect_name" required placeholder="Prénom Nom"></div>
          <div class="field"><label>Téléphone prospect</label><input name="prospect_phone" placeholder="514-000-0000"></div>
          <div class="field"><label>Courriel prospect</label><input type="email" name="prospect_email" placeholder="prospect@email.com"></div>
          <div class="field"><label>Date du RDV *</label><input type="date" name="appointment_date" required></div>
          <div class="field"><label>Heure du RDV *</label><input type="time" name="appointment_time" required></div>
          <div class="field"><label>Notes de qualification</label><input name="notes" placeholder="Besoin exprimé par le prospect"></div>
        </div>
        <div style="margin-top:12px;">
          <button type="submit" class="btn-gold btn-sm" style="padding:10px 18px;">📅 Enregistrer le RDV & notifier par SMS</button>
        </div>
      </form>
      <div class="table-scroll">
        <table class="pd-table">
          <thead>
            <tr>
              <th>Client</th>
              <th>Prospect</th>
              <th>Créneau</th>
              <th>Notes</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${apptRows || '<tr><td colspan="5" style="color:var(--text-muted);text-align:center;padding:18px;">Aucun rendez-vous enregistré.</td></tr>'}
          </tbody>
        </table>
      </div>
    </section>

    <section class="admin-card">
      <h2 class="display" style="font-size:1.75rem;color:#fff;margin-bottom:14px;">Publier une actualité Google Business Profile (avec NyXia)</h2>
      <form onsubmit="submitGooglePost(event)">
        <div class="field-grid">
          <div class="field"><label>Entreprise cible *</label><select id="post-client-id" name="client_id" required>${clientOptions}</select></div>
          <div class="field"><label>Thème ou promotion du post</label><input id="post-topic" placeholder="Ex: Disponibilités cette semaine, offre découverte..."></div>
          <div class="field"><label>URL photo (optionnel)</label><input name="media_url" placeholder="https://..."></div>
          <div class="field">
            <label>Bouton d'action</label>
            <select name="cta_type">
              <option value="BOOK">Réserver (BOOK)</option>
              <option value="LEARN_MORE">En savoir plus (LEARN_MORE)</option>
              <option value="CALL">Appeler (CALL)</option>
            </select>
          </div>
          <div class="field"><label>Lien du bouton (ex: agenda Google)</label><input name="cta_url" placeholder="https://calendar.app.google/..."></div>
        </div>
        <div class="field" style="margin-top:12px;">
          <label>Texte de la publication Google *</label>
          <textarea id="post-summary" name="summary" rows="3" required placeholder="Rédige le post ou clique sur ✨ Rédiger avec NyXia..."></textarea>
        </div>
        <div class="actions-stack" style="margin-top:12px;">
          <button type="button" class="btn-sm btn-gold" style="padding:10px 16px;" onclick="generateAiPost()">✨ Rédiger avec NyXia</button>
          <button type="submit" class="btn-primary">Publier sur Google</button>
        </div>
      </form>
    </section>

    <section class="admin-card">
      <h2 class="display" style="font-size:1.75rem;color:#fff;margin-bottom:14px;">Avis Google Clients & Réponses IA</h2>
      <div class="table-scroll">
        <table class="pd-table">
          <thead>
            <tr>
              <th>Entreprise & Note</th>
              <th>Commentaire</th>
              <th>Réponse publique</th>
            </tr>
          </thead>
          <tbody>
            ${reviewsRows || '<tr><td colspan="3" style="color:var(--text-muted);text-align:center;padding:18px;">Aucun avis synchronisé. Clique sur « Sync Avis » sur une fiche connectée.</td></tr>'}
          </tbody>
        </table>
      </div>
    </section>

    <section class="admin-card">
      <h2 class="display" style="font-size:1.75rem;color:#fff;margin-bottom:14px;">Demandes entrantes depuis la Revue Heyzine</h2>
      <div class="table-scroll">
        <table class="pd-table">
          <thead>
            <tr>
              <th>Prospect</th>
              <th>Entreprise demandée</th>
              <th>Statut</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            ${leadsRows || '<tr><td colspan="4" style="color:var(--text-muted);text-align:center;padding:18px;">Aucune demande entrante enregistrée.</td></tr>'}
          </tbody>
        </table>
      </div>
    </section>

    <section class="admin-card">
      <h2 class="display" style="font-size:1.5rem;color:var(--gold);margin-bottom:10px;">Sécurité • Mot de passe Associé / Équipe</h2>
      <p style="color:var(--text-secondary);font-size:.88rem;margin-bottom:14px;">Définis un second mot de passe chiffré dans D1 pour ton associé ou tes setters sans partager ton mot de passe maître Cloudflare.</p>
      <form onsubmit="updateTeamPassword(event)" style="display:flex;gap:12px;flex-wrap:wrap;max-width:520px;">
        <div class="field" style="flex:1;min-width:220px;">
          <input type="password" id="team-pass-input" placeholder="Nouveau mot de passe équipe (min. 6 car.)" required>
        </div>
        <button type="submit" class="btn-ghost">Enregistrer</button>
      </form>
    </section>
  </main>

  <div id="edit-modal" class="modal-backdrop">
    <div class="modal-box">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
        <h3 class="display" style="font-size:1.7rem;color:var(--gold);">Modifier la fiche entrepreneur</h3>
        <button class="btn-sm btn-ghost" onclick="closeEditModal()">✕ Fermer</button>
      </div>
      <form id="edit-client-form" onsubmit="submitEditClient(event)">
        <input type="hidden" name="id" id="edit-id">
        <div class="field-grid">
          <div class="field"><label>Entreprise *</label><input name="business_name" id="edit-business_name" required></div>
          <div class="field"><label>Propriétaire</label><input name="owner_name" id="edit-owner_name"></div>
          <div class="field"><label>Ville</label><input name="city" id="edit-city"></div>
          <div class="field"><label>Région</label><input name="region" id="edit-region"></div>
          <div class="field"><label>Catégorie</label><input name="category" id="edit-category"></div>
          <div class="field"><label>Téléphone</label><input name="phone" id="edit-phone"></div>
          <div class="field"><label>Courriel</label><input name="email" id="edit-email"></div>
          <div class="field"><label>Site web</label><input name="website_url" id="edit-website_url"></div>
          <div class="field"><label>Lien Agenda Google Workspace</label><input name="booking_calendar_url" id="edit-booking_calendar_url"></div>
          <div class="field"><label>Page revue Heyzine</label><input type="number" name="heyzine_page" id="edit-heyzine_page"></div>
          <div class="field"><label>ID Vidéo YouTube</label><input name="youtube_video_id" id="edit-youtube_video_id"></div>
          <div class="field"><label>Google Place ID</label><input name="google_place_id" id="edit-google_place_id"></div>
          <div class="field"><label>URL Logo</label><input name="logo_url" id="edit-logo_url"></div>
          <div class="field"><label>Statut</label><select name="status" id="edit-status"><option value="actif">Actif</option><option value="pause">En pause</option></select></div>
        </div>
        <div class="field" style="margin-top:12px;"><label>Consignes Setters</label><input name="booking_notes" id="edit-booking_notes"></div>
        <div class="field" style="margin-top:12px;"><label>Photos galerie (max 5 URLs séparées par virgule)</label><input name="gallery_urls" id="edit-gallery_urls"></div>
        <div style="margin-top:18px;display:flex;justify-content:flex-end;gap:10px;">
          <button type="button" class="btn-ghost" onclick="closeEditModal()">Annuler</button>
          <button type="submit" class="btn-primary">Sauvegarder les modifications</button>
        </div>
      </form>
    </div>
  </div>

  <div id="toast" class="toast"></div>

  <script>
    function showToast(msg, isErr = false) {
      const el = document.getElementById('toast');
      el.textContent = msg;
      el.style.borderColor = isErr ? '#f87171' : '#F4C842';
      el.style.display = 'block';
      setTimeout(() => { el.style.display = 'none'; }, 4200);
    }

    async function postJSON(url, data) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      return await res.json();
    }

    async function submitNewClient(e) {
      e.preventDefault();
      const fd = new FormData(e.target);
      const data = Object.fromEntries(fd.entries());
      data.gallery_urls = (data.gallery_urls || '').split(',').map(s => s.trim()).filter(Boolean);
      const r = await postJSON('/api/clients', data);
      if (!r.ok) return showToast(r.error, true);
      showToast(r.message);
      setTimeout(() => location.reload(), 700);
    }

    function openEditModal(c) {
      document.getElementById('edit-id').value = c.id;
      document.getElementById('edit-business_name').value = c.business_name || c.name || '';
      document.getElementById('edit-owner_name').value = c.owner_name || '';
      document.getElementById('edit-city').value = c.city || '';
      document.getElementById('edit-region').value = c.region || '';
      document.getElementById('edit-category').value = c.category || '';
      document.getElementById('edit-phone').value = c.phone || '';
      document.getElementById('edit-email').value = c.email || '';
      document.getElementById('edit-website_url').value = c.website_url || '';
      document.getElementById('edit-booking_calendar_url').value = c.booking_calendar_url || '';
      document.getElementById('edit-heyzine_page').value = c.heyzine_page || 1;
      document.getElementById('edit-youtube_video_id').value = c.youtube_video_id || '';
      document.getElementById('edit-google_place_id').value = c.google_place_id || '';
      document.getElementById('edit-logo_url').value = c.logo_url || '';
      document.getElementById('edit-status').value = c.status || 'actif';
      document.getElementById('edit-booking_notes').value = c.booking_notes || '';
      let photos = [];
      try { photos = JSON.parse(c.gallery_urls || '[]'); } catch (_) {}
      document.getElementById('edit-gallery_urls').value = photos.join(', ');
      document.getElementById('edit-modal').classList.add('open');
    }

    function closeEditModal() {
      document.getElementById('edit-modal').classList.remove('open');
    }

    async function submitEditClient(e) {
      e.preventDefault();
      const fd = new FormData(e.target);
      const data = Object.fromEntries(fd.entries());
      data.gallery_urls = (data.gallery_urls || '').split(',').map(s => s.trim()).filter(Boolean);
      const r = await postJSON('/api/clients/update', data);
      if (!r.ok) return showToast(r.error, true);
      showToast(r.message);
      setTimeout(() => location.reload(), 700);
    }

    async function deleteClient(id, name) {
      if (!confirm('Supprimer définitivement ' + name + ' ?')) return;
      const r = await postJSON('/api/clients/delete', { id });
      if (!r.ok) return showToast(r.error, true);
      location.reload();
    }

    async function syncReviews(clientId) {
      showToast('Synchronisation Google en cours...');
      const r = await postJSON('/api/gbp/sync-reviews', { client_id: clientId });
      if (!r.ok) return showToast(r.error, true);
      showToast(r.message);
      setTimeout(() => location.reload(), 900);
    }

    async function generateAiReply(reviewId, biz, cat, city, comment) {
      showToast('NyXia rédige une réponse...');
      const r = await postJSON('/api/ai/generate', {
        mode: 'reply',
        business_name: biz,
        category: cat,
        city: city,
        context_text: comment || 'Avis 5 étoiles sans commentaire écrit.'
      });
      if (!r.ok) return showToast(r.error, true);
      document.getElementById('reply-box-' + reviewId).value = r.text;
      showToast('Réponse prête ! Vérifie et clique sur Publier.');
    }

    async function sendReviewReply(reviewId) {
      const text = document.getElementById('reply-box-' + reviewId).value.trim();
      if (!text) return showToast('Écris une réponse avant de publier.', true);
      const r = await postJSON('/api/gbp/reply-review', { review_id: reviewId, reply_text: text });
      if (!r.ok) return showToast(r.error, true);
      showToast(r.message);
      setTimeout(() => location.reload(), 800);
    }

    async function generateAiPost() {
      const sel = document.getElementById('post-client-id');
      const biz = sel.options[sel.selectedIndex]?.text || 'Entreprise';
      const topic = document.getElementById('post-topic').value || 'Mise en avant de nos services et disponibilités de rendez-vous';
      showToast('NyXia rédige le Google Post...');
      const r = await postJSON('/api/ai/generate', {
        mode: 'post',
        business_name: biz,
        context_text: topic
      });
      if (!r.ok) return showToast(r.error, true);
      document.getElementById('post-summary').value = r.text;
      showToast('Post généré !');
    }

    async function submitGooglePost(e) {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(e.target).entries());
      const r = await postJSON('/api/gbp/create-post', data);
      if (!r.ok) return showToast(r.error, true);
      showToast(r.message);
      e.target.reset();
    }

    async function submitAppointment(e) {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(e.target).entries());
      const r = await postJSON('/api/appointments', data);
      if (!r.ok) return showToast(r.error, true);
      showToast(r.message);
      setTimeout(() => location.reload(), 800);
    }

    async function deleteAppointment(id) {
      const r = await postJSON('/api/appointments/delete', { id });
      if (!r.ok) return showToast(r.error, true);
      location.reload();
    }

    async function testSms() {
      const r = await postJSON('/api/sms/test', {});
      if (!r.ok) return showToast(r.error, true);
      showToast(r.message);
    }

    async function updateTeamPassword(e) {
      e.preventDefault();
      const pwd = document.getElementById('team-pass-input').value;
      const r = await postJSON('/api/settings/team-password', { new_password: pwd });
      if (!r.ok) return showToast(r.error, true);
      showToast(r.message);
      e.target.reset();
    }
  </script>
</body>
</html>`;
}
