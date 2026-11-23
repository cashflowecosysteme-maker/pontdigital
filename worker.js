// ============================================================================
// PONT DIGITAL — SUPER ADMIN WORKER UNIFIÉ (CLOUDFLARE WORKERS + D1)
// Disposition : KPI + Modale complète + /images/FavIcon.png + /images/NyXia.png
//               + /css/index.css + /js/starry-bg.js
// Moteur D1   : Schéma exact Worker 1 (Webhook Heyzine, Invitations GCal,
//               Multi-fiches Agence GBP, Posts Multi-Formats, Réponses 1-clic)
// ============================================================================

const FAVICON_URL = '/images/FavIcon.png';
const NYXIA_AVATAR_URL = '/images/NyXia.png';
const CSS_URL = '/css/index.css';
const STARRY_JS_URL = '/js/starry-bg.js';

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      // 0. Servir les assets statiques (/images/*, /css/*, /js/*) et le favicon
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

      // 1. Initialisation et migration non-destructive de la base D1
      await ensureDatabaseReady(env.DB);

      // 2. Webhook public Heyzine Pro (verrouillé par client_id -> alerte SMS agence)
      if (path === '/webhook/heyzine' && request.method === 'POST') {
        return handleHeyzineWebhook(request, env);
      }

      // 3. Connexion & Déconnexion SuperAdmin
      if (path === '/login' && request.method === 'POST') {
        return handleLogin(request, env);
      }
      if (path === '/logout') {
        return new Response(null, {
          status: 302,
          headers: {
            'Location': '/',
            'Set-Cookie': 'pd_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0'
          }
        });
      }

      // 4. Callback OAuth Google Business Profile (retour de Google)
      if (path === '/oauth/google/callback' && request.method === 'GET') {
        return handleGoogleOAuthCallback(request, env);
      }

      // 5. Vérification de la session active SuperAdmin
      const isAuthenticated = await verifySession(request, env);
      if (!isAuthenticated) {
        return new Response(renderLoginHTML(), {
          headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
      }

      // 6. Démarrage & Sélection de fiche OAuth Google (Mode Agence Multi-Fiches)
      if (path === '/oauth/google/connect' && request.method === 'GET') {
        return handleGoogleOAuthStart(request, env);
      }
      if (path === '/oauth/google/select-location' && request.method === 'GET') {
        return handleSelectGoogleLocationPage(request, env);
      }
      if (path === '/api/google/assign-location' && request.method === 'POST') {
        return handleAssignGoogleLocationPost(request, env);
      }

      // 7. Actions Google Business Profile (Sync Avis, Studio Multi-Posts & Réponse NyXia)
      if (path === '/api/google/sync-reviews' && request.method === 'POST') {
        return handleSyncReviewsRoute(request, env);
      }
      if (path === '/api/google/create-post' && request.method === 'POST') {
        return handleCreateGooglePostRoute(request, env);
      }
      if (path === '/api/google/reply-review' && request.method === 'POST') {
        return handleReplyReviewWithNyxiaRoute(request, env);
      }

      // 8. Générateur IA NyXia pour rédiger un post client à la demande
      if (path === '/api/nyxia/draft-post' && request.method === 'POST') {
        return handleNyxiaDraftPostApi(request, env);
      }

      // 9. Module Appointment Setter (Création de RDV qualifiés + Agenda Google Workspace)
      if (path === '/api/setter/book' && request.method === 'POST') {
        return handleBookAppointmentRoute(request, env);
      }
      if (path === '/api/setter/delete' && request.method === 'POST') {
        return handleDeleteAppointmentRoute(request, env);
      }

      // 10. Test manuel & suivi Done-For-You des leads
      if (path === '/api/test-nyxia-sms' && request.method === 'POST') {
        return handleTestNyxiaSmsRoute(request, env);
      }
      if (path === '/api/leads/status' && request.method === 'POST') {
        return handleUpdateLeadStatus(request, env);
      }

      // 11. Gestion des entrepreneurs, agendas, galerie & sécurité équipe
      if (path === '/api/change-password' && request.method === 'POST') {
        return handleChangePassword(request, env);
      }
      if (path === '/api/clients' && request.method === 'POST') {
        return handleAddClient(request, env);
      }
      if (path === '/api/clients/update' && request.method === 'POST') {
        return handleUpdateClientFull(request, env);
      }
      if (path === '/api/clients/delete' && request.method === 'POST') {
        return handleDeleteClient(request, env);
      }

      // 12. Chargement des données et affichage du Tableau de Bord
      const { results: clients } = await env.DB.prepare(`
        SELECT c.*,
               (SELECT COUNT(*) FROM google_reviews r WHERE r.client_id = c.id) AS review_count,
               (SELECT COUNT(*) FROM google_posts p WHERE p.client_id = c.id) AS post_count,
               (SELECT COUNT(*) FROM heyzine_leads l WHERE l.client_id = c.id) AS lead_count,
               (SELECT COUNT(*) FROM appointments a WHERE a.client_id = c.id) AS rdv_count
        FROM clients c
        ORDER BY c.created_at DESC
      `).all();

      const { results: recentReviews } = await env.DB.prepare(`
        SELECT r.*, c.business_name, c.city, c.category, c.google_refresh_token
        FROM google_reviews r
        JOIN clients c ON c.id = r.client_id
        ORDER BY r.review_updated_at DESC
        LIMIT 12
      `).all();

      const { results: recentLeads } = await env.DB.prepare(`
        SELECT l.*, c.business_name
        FROM heyzine_leads l
        LEFT JOIN clients c ON c.id = l.client_id
        ORDER BY l.created_at DESC
        LIMIT 12
      `).all();

      const { results: recentAppointments } = await env.DB.prepare(`
        SELECT a.*, c.business_name, c.city, c.client_email, c.booking_calendar_url
        FROM appointments a
        JOIN clients c ON c.id = a.client_id
        ORDER BY a.created_at DESC
        LIMIT 12
      `).all();

      return new Response(
        renderDashboardHTML(clients, recentReviews, recentLeads, recentAppointments, url.searchParams.get('msg'), url.origin),
        { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
      );
    } catch (err) {
      return renderErrorHTML('Erreur technique interceptée', `${err.message}\n\n${err.stack || ''}`);
    }
  },

  // Tâche planifiée nocturne : synchronisation silencieuse des avis Google de tous les clients
  async scheduled(event, env, ctx) {
    ctx.waitUntil(syncAllConnectedClientsReviews(env));
  }
};

// ============================================================================
// INITIALISATION & MIGRATION AUTOMATIQUE DE LA BASE D1 (SCHÉMA EXACT WORKER 1)
// ============================================================================

async function ensureDatabaseReady(db) {
  await db.batch([
    db.prepare(`
      CREATE TABLE IF NOT EXISTS admin_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS clients (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        business_name TEXT NOT NULL,
        city TEXT NOT NULL,
        category TEXT NOT NULL,
        phone TEXT,
        client_email TEXT,
        booking_calendar_url TEXT,
        booking_notes TEXT,
        heyzine_url TEXT,
        interview_video_url TEXT,
        cover_photo_url TEXT,
        gallery_urls TEXT,
        google_place_id TEXT,
        google_account_name TEXT,
        google_location_name TEXT,
        google_location_title TEXT,
        google_refresh_token TEXT,
        status TEXT DEFAULT 'active',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS google_reviews (
        review_id TEXT PRIMARY KEY,
        client_id INTEGER NOT NULL,
        reviewer_name TEXT,
        star_rating INTEGER,
        comment TEXT,
        reply_comment TEXT,
        review_updated_at TEXT,
        synced_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS google_posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id INTEGER NOT NULL,
        google_post_name TEXT,
        topic_type TEXT DEFAULT 'STANDARD',
        summary TEXT NOT NULL,
        cta_url TEXT,
        media_url TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS heyzine_leads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id INTEGER,
        prospect_name TEXT,
        prospect_contact TEXT,
        prospect_message TEXT,
        source_url TEXT,
        nyxia_sms_text TEXT,
        sms_status TEXT DEFAULT 'pending',
        handling_status TEXT DEFAULT 'nouveau',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS appointments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id INTEGER NOT NULL,
        prospect_name TEXT NOT NULL,
        prospect_email TEXT,
        prospect_phone TEXT,
        appointment_datetime TEXT NOT NULL,
        duration_minutes INTEGER DEFAULT 30,
        setter_notes TEXT,
        gcal_event_url TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)
  ]);

  const migrations = [
    'ALTER TABLE clients ADD COLUMN google_account_name TEXT',
    'ALTER TABLE clients ADD COLUMN google_location_name TEXT',
    'ALTER TABLE clients ADD COLUMN google_location_title TEXT',
    'ALTER TABLE clients ADD COLUMN interview_video_url TEXT',
    'ALTER TABLE clients ADD COLUMN cover_photo_url TEXT',
    'ALTER TABLE clients ADD COLUMN gallery_urls TEXT',
    'ALTER TABLE clients ADD COLUMN client_email TEXT',
    'ALTER TABLE clients ADD COLUMN booking_calendar_url TEXT',
    'ALTER TABLE clients ADD COLUMN booking_notes TEXT',
    "ALTER TABLE google_posts ADD COLUMN topic_type TEXT DEFAULT 'STANDARD'",
    'ALTER TABLE google_posts ADD COLUMN media_url TEXT',
    "ALTER TABLE heyzine_leads ADD COLUMN handling_status TEXT DEFAULT 'nouveau'"
  ];
  for (const sql of migrations) {
    try {
      await db.prepare(sql).run();
    } catch (e) {
      // Colonne déjà présente
    }
  }
}

// ============================================================================
// MODULE APPOINTMENT SETTER + GÉNÉRATEUR D'INVITATION GOOGLE WORKSPACE
// ============================================================================

function buildGoogleCalendarInviteUrl({ title, startIso, durationMinutes, details, location, guests }) {
  const startDate = new Date(startIso);
  const validStart = isNaN(startDate.getTime()) ? new Date() : startDate;
  const endDate = new Date(validStart.getTime() + (durationMinutes || 30) * 60000);

  const fmt = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const datesParam = `${fmt(validStart)}/${fmt(endDate)}`;

  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: title,
    dates: datesParam,
    details,
    location
  });

  if (guests && guests.length > 0) {
    params.set('add', guests.join(','));
  }

  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

async function handleBookAppointmentRoute(request, env) {
  const formData = await request.formData();
  const clientId = formData.get('client_id');
  const prospectName = (formData.get('prospect_name') || '').trim();
  const prospectEmail = (formData.get('prospect_email') || '').trim();
  const prospectPhone = (formData.get('prospect_phone') || '').trim();
  const appointmentDatetime = (formData.get('appointment_datetime') || '').trim();
  const durationMinutes = parseInt(formData.get('duration_minutes') || '30', 10) || 30;
  const setterNotes = (formData.get('setter_notes') || '').trim();

  if (!clientId || !prospectName || !appointmentDatetime) {
    return Response.redirect(new URL('/?msg=error_fields', request.url), 302);
  }

  const client = await env.DB.prepare('SELECT * FROM clients WHERE id = ?').bind(clientId).first();
  if (!client) {
    return Response.redirect(new URL('/?msg=error_fields', request.url), 302);
  }

  const guests = [client.client_email, prospectEmail].filter(Boolean);
  const title = `RDV Pont Digital — ${prospectName} x ${client.business_name}`;
  const details =
    `Rendez-vous qualifié par l'équipe Pont Digital (NyXia).\n\n` +
    `Entrepreneur : ${client.business_name} (${client.city})\n` +
    `Prospect : ${prospectName}\n` +
    `Téléphone : ${prospectPhone || 'Non précisé'}\n` +
    `Courriel : ${prospectEmail || 'Non précisé'}\n\n` +
    `Notes de qualification du Setter :\n${setterNotes || 'Prospect qualifié prêt pour soumission / rencontre.'}`;

  const gcalUrl = buildGoogleCalendarInviteUrl({
    title,
    startIso: appointmentDatetime,
    durationMinutes,
    details,
    location: `${client.city}, Québec (ou Google Meet)`,
    guests
  });

  await env.DB.prepare(`
    INSERT INTO appointments (client_id, prospect_name, prospect_email, prospect_phone, appointment_datetime, duration_minutes, setter_notes, gcal_event_url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    client.id,
    prospectName,
    prospectEmail,
    prospectPhone,
    appointmentDatetime,
    durationMinutes,
    setterNotes,
    gcalUrl
  ).run();

  await env.DB.prepare(`
    UPDATE heyzine_leads
    SET handling_status = 'rdv_confirme'
    WHERE client_id = ? AND prospect_name LIKE ? AND handling_status != 'rdv_confirme'
  `).bind(client.id, `%${prospectName}%`).run();

  return Response.redirect(new URL('/?msg=rdv_booked', request.url), 302);
}

async function handleDeleteAppointmentRoute(request, env) {
  const formData = await request.formData();
  const id = formData.get('id');
  if (id) {
    await env.DB.prepare('DELETE FROM appointments WHERE id = ?').bind(id).run();
  }
  return Response.redirect(new URL('/?msg=rdv_deleted', request.url), 302);
}

// ============================================================================
// GÉNÉRATEUR IA NYXIA POUR RÉDIGER DES POSTS SUR MESURE PAR CLIENT
// ============================================================================

async function handleNyxiaDraftPostApi(request, env) {
  try {
    const body = await request.json();
    const clientId = body.client_id;
    const topicType = body.topic_type || 'STANDARD';
    const angle = String(body.angle || '').trim();

    if (!clientId) {
      return jsonResponse({ error: 'Sélectionne d’abord un entrepreneur.' }, 400);
    }

    const client = await env.DB.prepare('SELECT * FROM clients WHERE id = ?').bind(clientId).first();
    if (!client) {
      return jsonResponse({ error: 'Client introuvable.' }, 404);
    }

    const typeLabels = {
      STANDARD: 'une actualité locale mettant en valeur son reportage vidéo et son entrevue dans la revue interactive Pont Digital',
      OFFER: 'une offre spéciale ou promotion exclusive pour attirer des clients locaux',
      EVENT: 'une invitation à un événement, une porte ouverte ou une rencontre découverte'
    };

    const fallbackText = `Découvrez ${client.business_name} à ${client.city} ! Spécialiste en ${client.category}, notre équipe vous accompagne avec passion. Consultez notre entrevue exclusive dans la revue interactive Pont Digital et contactez-nous dès aujourd’hui !`;

    if (!env.OPENROUTER_API_KEY) {
      return jsonResponse({ draft: fallbackText, default_media: client.cover_photo_url || '', default_cta: client.heyzine_url || '' });
    }

    const model = env.OPENROUTER_MODEL || 'google/gemini-2.5-flash';
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://SuperAdmin-Pontdigital.nyxia.top',
        'X-Title': 'Pont Digital - NyXia Post Studio'
      },
      body: JSON.stringify({
        model,
        temperature: 0.6,
        max_tokens: 280,
        messages: [
          {
            role: 'system',
            content:
              'Tu es NyXia, stratège de visibilité locale pour les entrepreneurs québécois sur Pont Digital. Rédige une publication Google Business Profile engageante, chaleureuse et optimisée SEO local (avec le nom de l’entreprise, sa ville et sa spécialité). Règles : français québécois naturel, 350 à 550 caractères maximum, aucun hashtag (Google Business Profile déconseille les hashtags), aucun guillemet autour du texte, appel à l’action clair à la fin.'
          },
          {
            role: 'user',
            content: `Entreprise : ${client.business_name}\nVille : ${client.city}\nSpécialité : ${client.category}\nType de publication : ${typeLabels[topicType] || typeLabels.STANDARD}\nConsigne particulière : ${angle || 'Mettre en valeur son savoir-faire et son entrevue vidéo'}`
          }
        ]
      })
    });

    const data = await res.json();
    const draft = data.choices?.[0]?.message?.content?.trim() || fallbackText;

    return jsonResponse({
      draft,
      default_media: client.cover_photo_url || '',
      default_cta: client.heyzine_url || ''
    });
  } catch (e) {
    return jsonResponse({ error: 'Erreur lors de la rédaction par NyXia.' }, 500);
  }
}

// ============================================================================
// RÉPONSE AUTOMATIQUE AUX AVIS GOOGLE PAR NYXIA (1 CLIC)
// ============================================================================

async function handleReplyReviewWithNyxiaRoute(request, env) {
  const formData = await request.formData();
  const reviewId = formData.get('review_id');
  if (!reviewId) {
    return Response.redirect(new URL('/?msg=error_fields', request.url), 302);
  }

  const row = await env.DB.prepare(`
    SELECT r.*, c.id AS db_client_id, c.business_name, c.city, c.category,
           c.google_refresh_token, c.google_account_name, c.google_location_name
    FROM google_reviews r
    JOIN clients c ON c.id = r.client_id
    WHERE r.review_id = ?
  `).bind(reviewId).first();

  if (!row || !row.google_refresh_token) {
    return Response.redirect(new URL('/?msg=google_not_connected', request.url), 302);
  }

  try {
    const replyText = await generateNyxiaReviewReply({
      env,
      businessName: row.business_name,
      city: row.city,
      category: row.category,
      reviewerName: row.reviewer_name,
      starRating: row.star_rating,
      comment: row.comment
    });

    const accessToken = await getGoogleAccessToken(row.google_refresh_token, env);
    let accountName = row.google_account_name;
    let locationName = row.google_location_name;

    if (!accountName || !locationName) {
      const allLocs = await listAllGoogleLocations(accessToken);
      if (allLocs.length > 0) {
        accountName = allLocs[0].accountName;
        locationName = allLocs[0].locationName;
      }
    }

    const fullResource = normalizeFullLocationResource(accountName, locationName);
    if (!fullResource) {
      return Response.redirect(new URL('/?msg=google_api_error', request.url), 302);
    }

    const cleanReviewId = row.review_id.includes('/reviews/')
      ? row.review_id.split('/reviews/').pop()
      : row.review_id;

    const googleReplyRes = await fetch(
      `https://mybusiness.googleapis.com/v4/${fullResource}/reviews/${encodeURIComponent(cleanReviewId)}/reply`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ comment: replyText })
      }
    );

    if (!googleReplyRes.ok) {
      return Response.redirect(new URL('/?msg=google_api_error', request.url), 302);
    }

    await env.DB.prepare(`
      UPDATE google_reviews
      SET reply_comment = ?, synced_at = CURRENT_TIMESTAMP
      WHERE review_id = ?
    `).bind(replyText, row.review_id).run();

    return Response.redirect(new URL('/?msg=review_replied', request.url), 302);
  } catch (e) {
    return Response.redirect(new URL('/?msg=google_api_error', request.url), 302);
  }
}

async function generateNyxiaReviewReply({ env, businessName, city, category, reviewerName, starRating, comment }) {
  const isPositive = (starRating || 5) >= 4;
  const fallbackReply = isPositive
    ? `Merci infiniment ${reviewerName} pour votre confiance et votre belle note ! Toute l'équipe de ${businessName} à ${city} est ravie d'avoir pu vous accompagner. Au plaisir de vous revoir très bientôt !`
    : `Bonjour ${reviewerName}, merci d'avoir pris le temps de partager votre retour. Chez ${businessName} à ${city}, votre satisfaction est notre priorité absolue et nous aimerions échanger avec vous afin d'améliorer votre expérience. N'hésitez pas à nous contacter directement.`;

  if (!env.OPENROUTER_API_KEY) {
    return fallbackReply;
  }

  const model = env.OPENROUTER_MODEL || 'google/gemini-2.5-flash';

  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://SuperAdmin-Pontdigital.nyxia.top',
        'X-Title': 'Pont Digital - NyXia Review Responder'
      },
      body: JSON.stringify({
        model,
        temperature: 0.5,
        max_tokens: 240,
        messages: [
          {
            role: 'system',
            content:
              'Tu es NyXia, experte en réputation locale et visibilité IA pour les entrepreneurs québécois sur Pont Digital. Rédige une réponse officielle au nom de l’entreprise à un avis Google. Règles strictes : ton chaleureux, humain et authentique en français québécois professionnel ; intègre naturellement le nom de l’entreprise, sa ville et son domaine d’activité pour renforcer le SEO local sans jamais paraître robotique ; maximum 450 caractères ; aucun hashtag, aucun guillemet autour de la réponse. Si la note est de 3 étoiles ou moins, reste calme, empathique et invite le client à contacter l’équipe directement pour régler la situation.'
          },
          {
            role: 'user',
            content: `Entreprise : ${businessName}\nVille : ${city}\nSpécialité : ${category}\nAuteur de l'avis : ${reviewerName}\nNote : ${starRating}/5\nCommentaire : ${comment || '(Aucun texte laissé avec la note)'}`
          }
        ]
      })
    });

    const data = await res.json();
    const generated = data.choices?.[0]?.message?.content?.trim();
    return generated || fallbackReply;
  } catch (e) {
    return fallbackReply;
  }
}

// ============================================================================
// WEBHOOK HEYZINE PRO -> NYXIA -> ALERTE SMS AGENCE DONE-FOR-YOU
// ============================================================================

async function handleHeyzineWebhook(request, env) {
  const url = new URL(request.url);

  if (env.HEYZINE_WEBHOOK_SECRET) {
    const providedToken = url.searchParams.get('token') || request.headers.get('X-Webhook-Token') || '';
    if (!timingSafeEqual(providedToken, env.HEYZINE_WEBHOOK_SECRET)) {
      return new Response(JSON.stringify({ ok: false, error: 'Unauthorized webhook token' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  let payload = {};
  const contentType = request.headers.get('Content-Type') || '';
  try {
    if (contentType.includes('application/json')) {
      payload = await request.json();
    } else if (contentType.includes('form')) {
      const fd = await request.formData();
      payload = Object.fromEntries(fd.entries());
    } else {
      const rawText = await request.text();
      payload = rawText ? JSON.parse(rawText) : {};
    }
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: 'Invalid payload format' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const data = payload.data || payload.form || payload;
  const prospectName = String(data.name || data.nom || data.full_name || data.fullname || 'Un visiteur').trim();
  const prospectEmail = String(data.email || data.courriel || '').trim();
  const prospectPhone = String(data.phone || data.telephone || data.tel || '').trim();
  const prospectContact = [prospectPhone, prospectEmail].filter(Boolean).join(' | ') || 'Non précisé';
  const prospectMessage = String(data.message || data.comments || data.demande || data.notes || 'Demande d’information depuis la revue').trim();
  const sourceUrl = String(payload.flipbook_url || payload.url || data.flipbook_url || data.source_url || '').trim();
  const targetClientId = url.searchParams.get('client_id') || data.client_id || null;
  const targetBusinessName = String(data.business_name || data.entreprise || payload.flipbook_title || '').trim();

  let client = null;
  if (targetClientId) {
    client = await env.DB.prepare('SELECT * FROM clients WHERE id = ?').bind(targetClientId).first();
  }
  if (!client && sourceUrl) {
    client = await env.DB.prepare('SELECT * FROM clients WHERE heyzine_url = ?').bind(sourceUrl).first();
    if (!client) {
      const baseFlipbook = sourceUrl.split('#')[0].split('?')[0];
      client = await env.DB.prepare('SELECT * FROM clients WHERE heyzine_url LIKE ?').bind(`%${baseFlipbook}%`).first();
    }
  }
  if (!client && targetBusinessName) {
    client = await env.DB.prepare('SELECT * FROM clients WHERE business_name LIKE ?').bind(`%${targetBusinessName}%`).first();
  }

  const result = await processLeadWithNyxiaAndSms({
    env,
    client,
    prospectName,
    prospectContact,
    prospectMessage,
    sourceUrl
  });

  return new Response(JSON.stringify({ ok: true, ...result }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

async function handleTestNyxiaSmsRoute(request, env) {
  const formData = await request.formData();
  const clientId = formData.get('client_id');
  const prospectName = (formData.get('prospect_name') || 'Marc-André Tremblay').trim();
  const prospectContact = (formData.get('prospect_contact') || '514-555-0199').trim();
  const prospectMessage = (formData.get('prospect_message') || 'Bonjour, j’ai vu votre reportage dans la revue Pont Digital et j’aimerais une soumission.').trim();

  if (!clientId) {
    return Response.redirect(new URL('/?msg=error_fields', request.url), 302);
  }

  const client = await env.DB.prepare('SELECT * FROM clients WHERE id = ?').bind(clientId).first();
  if (!client) {
    return Response.redirect(new URL('/?msg=error_fields', request.url), 302);
  }

  await processLeadWithNyxiaAndSms({
    env,
    client,
    prospectName,
    prospectContact,
    prospectMessage,
    sourceUrl: client.heyzine_url || 'Test SuperAdmin'
  });

  return Response.redirect(new URL('/?msg=lead_processed', request.url), 302);
}

async function handleUpdateLeadStatus(request, env) {
  const formData = await request.formData();
  const leadId = formData.get('lead_id');
  const handlingStatus = formData.get('handling_status') || 'nouveau';
  if (leadId) {
    await env.DB.prepare('UPDATE heyzine_leads SET handling_status = ? WHERE id = ?')
      .bind(handlingStatus, leadId)
      .run();
  }
  return Response.redirect(new URL('/?msg=lead_status_updated', request.url), 302);
}

async function processLeadWithNyxiaAndSms({ env, client, prospectName, prospectContact, prospectMessage, sourceUrl }) {
  const businessName = client ? `${client.business_name} (${client.city})` : 'Partenaire Pont Digital';

  const smsText = await generateNyxiaSmsAlert({
    env,
    businessName,
    prospectName,
    prospectContact,
    prospectMessage
  });

  let smsStatus = 'agency_phone_missing';
  if (env.AGENCY_ALERT_PHONE) {
    smsStatus = await sendTwilioSms(env, env.AGENCY_ALERT_PHONE, smsText);
  }

  await env.DB.prepare(`
    INSERT INTO heyzine_leads (client_id, prospect_name, prospect_contact, prospect_message, source_url, nyxia_sms_text, sms_status, handling_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'nouveau')
  `).bind(
    client ? client.id : null,
    prospectName,
    prospectContact,
    prospectMessage,
    sourceUrl,
    smsText,
    smsStatus
  ).run();

  return { client_matched: businessName, sms_status: smsStatus, sms_preview: smsText };
}

async function generateNyxiaSmsAlert({ env, businessName, prospectName, prospectContact, prospectMessage }) {
  const fallbackSms = `ALERTE PONT DIGITAL (NyXia) — Lead Setter pour ${businessName} : ${prospectName} (${prospectContact}) -> "${prospectMessage.slice(0, 100)}"`;

  if (!env.OPENROUTER_API_KEY) {
    return fallbackSms;
  }

  const model = env.OPENROUTER_MODEL || 'google/gemini-2.5-flash';

  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://SuperAdmin-Pontdigital.nyxia.top',
        'X-Title': 'Pont Digital - NyXia Agency Alert'
      },
      body: JSON.stringify({
        model,
        temperature: 0.35,
        max_tokens: 180,
        messages: [
          {
            role: 'system',
            content:
              'Tu es NyXia, l’assistante de l’agence Pont Digital. Rédige une alerte SMS interne ultra-rapide destinée à l’équipe de Setters de Pont Digital pour les prévenir qu’un nouveau prospect vient de remplir un formulaire sur la page d’un de nos entrepreneurs clients afin de le qualifier et lui fixer un rendez-vous. Règles strictes : maximum 280 caractères, français québécois clair, aucun hashtag, aucun guillemet autour du texte, mentionne clairement pour QUEL client de l’agence est ce prospect, le nom du prospect, ses coordonnées et sa demande.'
          },
          {
            role: 'user',
            content: `Client Pont Digital concerné : ${businessName}\nProspect : ${prospectName}\nContact : ${prospectContact}\nDemande : ${prospectMessage}`
          }
        ]
      })
    });

    const data = await res.json();
    const generated = data.choices?.[0]?.message?.content?.trim();
    return generated || fallbackSms;
  } catch (e) {
    return fallbackSms;
  }
}

async function sendTwilioSms(env, rawToPhone, bodyText) {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_FROM_NUMBER) {
    return 'twilio_not_configured';
  }

  const digits = rawToPhone.replace(/\D/g, '');
  const toPhone = digits.length === 10 ? `+1${digits}` : (rawToPhone.startsWith('+') ? rawToPhone : `+${digits}`);

  try {
    const authHeader = 'Basic ' + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`);
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`,
      {
        method: 'POST',
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
          To: toPhone,
          From: env.TWILIO_FROM_NUMBER,
          Body: bodyText
        })
      }
    );
    return res.ok ? 'sent' : 'twilio_error';
  } catch (e) {
    return 'twilio_error';
  }
}

// ============================================================================
// FLUX OAUTH GOOGLE BUSINESS PROFILE + SÉLECTEUR MULTI-FICHES AGENCE
// ============================================================================

async function handleGoogleOAuthStart(request, env) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return Response.redirect(new URL('/?msg=google_missing_keys', request.url), 302);
  }

  const url = new URL(request.url);
  const clientId = url.searchParams.get('client_id');
  if (!clientId) {
    return Response.redirect(new URL('/?msg=error_fields', request.url), 302);
  }

  const secret = env.SESSION_SECRET || env.MASTER_ADMIN_PASSWORD;
  const payload = `${clientId}:${Date.now() + 600000}`;
  const sig = await signHmac(payload, secret);
  const state = encodeURIComponent(`${payload}.${sig}`);

  const redirectUri = `${url.origin}/oauth/google/callback`;
  const scope = encodeURIComponent('https://www.googleapis.com/auth/business.manage');

  const googleAuthUrl =
    `https://accounts.google.com/o/oauth2/v2/auth` +
    `?client_id=${encodeURIComponent(env.GOOGLE_CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&response_type=code` +
    `&scope=${scope}` +
    `&access_type=offline` +
    `&prompt=consent` +
    `&state=${state}`;

  return Response.redirect(googleAuthUrl, 302);
}

async function handleGoogleOAuthCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const rawState = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  if (error || !code || !rawState) {
    return Response.redirect(new URL('/?msg=google_oauth_error', request.url), 302);
  }

  const decodedState = decodeURIComponent(rawState);
  const lastDot = decodedState.lastIndexOf('.');
  if (lastDot === -1) {
    return Response.redirect(new URL('/?msg=google_oauth_error', request.url), 302);
  }

  const payload = decodedState.slice(0, lastDot);
  const sig = decodedState.slice(lastDot + 1);
  const secret = env.SESSION_SECRET || env.MASTER_ADMIN_PASSWORD;
  const expectedSig = await signHmac(payload, secret);

  if (!timingSafeEqual(sig, expectedSig)) {
    return Response.redirect(new URL('/?msg=google_oauth_error', request.url), 302);
  }

  const [dbClientId, expiresStr] = payload.split(':');
  if (Date.now() > parseInt(expiresStr, 10)) {
    return Response.redirect(new URL('/?msg=google_oauth_error', request.url), 302);
  }

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
    return Response.redirect(new URL('/?msg=google_oauth_error', request.url), 302);
  }

  if (tokenData.refresh_token) {
    await env.DB.prepare(`
      UPDATE clients
      SET google_refresh_token = ?
      WHERE id = ?
    `).bind(tokenData.refresh_token, dbClientId).run();
  }

  const locations = await listAllGoogleLocations(tokenData.access_token);

  if (locations.length === 1) {
    const loc = locations[0];
    await env.DB.prepare(`
      UPDATE clients
      SET google_account_name = ?,
          google_location_name = ?,
          google_location_title = ?,
          google_place_id = COALESCE(?, google_place_id)
      WHERE id = ?
    `).bind(loc.accountName, loc.locationName, loc.title, loc.placeId, dbClientId).run();

    return Response.redirect(new URL('/?msg=google_connected', request.url), 302);
  }

  if (locations.length > 1) {
    return Response.redirect(new URL(`/oauth/google/select-location?client_id=${encodeURIComponent(dbClientId)}`, request.url), 302);
  }

  return Response.redirect(new URL('/?msg=google_connected', request.url), 302);
}

async function handleSelectGoogleLocationPage(request, env) {
  const url = new URL(request.url);
  const clientId = url.searchParams.get('client_id');
  if (!clientId) {
    return Response.redirect(new URL('/?msg=error_fields', request.url), 302);
  }

  const client = await env.DB.prepare('SELECT * FROM clients WHERE id = ?').bind(clientId).first();
  if (!client || !client.google_refresh_token) {
    return Response.redirect(new URL('/?msg=google_not_connected', request.url), 302);
  }

  let locations = [];
  try {
    const accessToken = await getGoogleAccessToken(client.google_refresh_token, env);
    locations = await listAllGoogleLocations(accessToken);
  } catch (e) {
    return Response.redirect(new URL('/?msg=google_api_error', request.url), 302);
  }

  return new Response(renderSelectLocationHTML(client, locations), {
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

async function handleAssignGoogleLocationPost(request, env) {
  const formData = await request.formData();
  const clientId = formData.get('client_id');
  const packedLocation = formData.get('selected_location') || '';

  if (!clientId || !packedLocation) {
    return Response.redirect(new URL('/?msg=error_fields', request.url), 302);
  }

  const [accountName, locationName, placeId, title] = packedLocation.split('|||');

  await env.DB.prepare(`
    UPDATE clients
    SET google_account_name = ?,
        google_location_name = ?,
        google_place_id = COALESCE(NULLIF(?, ''), google_place_id),
        google_location_title = ?
    WHERE id = ?
  `).bind(accountName || null, locationName || null, placeId || '', title || null, clientId).run();

  return Response.redirect(new URL('/?msg=google_location_assigned', request.url), 302);
}

// ============================================================================
// APPELS API GOOGLE BUSINESS PROFILE (MULTI-POSTS : ACTUALITÉ, OFFRE, ÉVÉNEMENT)
// ============================================================================

async function getGoogleAccessToken(refreshToken, env) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    })
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error('Impossible de renouveler le jeton Google.');
  }
  return data.access_token;
}

async function listAllGoogleLocations(accessToken) {
  const results = [];
  try {
    const accountsRes = await fetch('https://mybusinessaccountmanagement.googleapis.com/v1/accounts', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const accountsData = await accountsRes.json();
    const accounts = accountsData.accounts || [];

    for (const acc of accounts) {
      const accountName = acc.name;
      const accountLabel = acc.accountName || accountName;
      if (!accountName) continue;

      let pageToken = '';
      do {
        const pageParam = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '';
        const locRes = await fetch(
          `https://mybusinessbusinessinformation.googleapis.com/v1/${accountName}/locations?readMask=name,title,storefrontAddress,metadata&pageSize=100${pageParam}`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        const locData = await locRes.json();
        const locs = locData.locations || [];

        for (const loc of locs) {
          const locality = loc.storefrontAddress?.locality || '';
          const region = loc.storefrontAddress?.administrativeArea || '';
          const cityLabel = [locality, region].filter(Boolean).join(', ');
          results.push({
            accountName,
            accountLabel,
            locationName: loc.name || '',
            title: loc.title || 'Établissement sans nom',
            cityLabel,
            placeId: loc.metadata?.placeId || ''
          });
        }
        pageToken = locData.nextPageToken || '';
      } while (pageToken);
    }
  } catch (e) {
    // Retourne les fiches trouvées jusqu'ici
  }
  return results;
}

function normalizeFullLocationResource(accountName, locationName) {
  if (!locationName) return null;
  if (locationName.startsWith('accounts/')) return locationName;
  if (accountName && locationName.startsWith('locations/')) {
    return `${accountName}/${locationName}`;
  }
  return locationName;
}

async function handleSyncReviewsRoute(request, env) {
  const formData = await request.formData();
  const clientId = formData.get('client_id');
  if (!clientId) return Response.redirect(new URL('/?msg=error_fields', request.url), 302);

  const client = await env.DB.prepare('SELECT * FROM clients WHERE id = ?').bind(clientId).first();
  if (!client || !client.google_refresh_token) {
    return Response.redirect(new URL('/?msg=google_not_connected', request.url), 302);
  }

  try {
    await syncReviewsForClient(client, env);
    return Response.redirect(new URL('/?msg=reviews_synced', request.url), 302);
  } catch (e) {
    return Response.redirect(new URL('/?msg=google_api_error', request.url), 302);
  }
}

async function syncReviewsForClient(client, env) {
  const accessToken = await getGoogleAccessToken(client.google_refresh_token, env);

  let accountName = client.google_account_name;
  let locationName = client.google_location_name;

  if (!accountName || !locationName) {
    const allLocs = await listAllGoogleLocations(accessToken);
    if (allLocs.length > 0) {
      accountName = allLocs[0].accountName;
      locationName = allLocs[0].locationName;
      await env.DB.prepare(`
        UPDATE clients
        SET google_account_name = ?, google_location_name = ?, google_location_title = ?, google_place_id = COALESCE(?, google_place_id)
        WHERE id = ?
      `).bind(accountName, locationName, allLocs[0].title, allLocs[0].placeId, client.id).run();
    }
  }

  const fullResource = normalizeFullLocationResource(accountName, locationName);
  if (!fullResource) throw new Error('Aucun établissement Google trouvé.');

  const reviewsRes = await fetch(
    `https://mybusiness.googleapis.com/v4/${fullResource}/reviews?pageSize=50`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const reviewsData = await reviewsRes.json();
  if (!reviewsRes.ok) {
    throw new Error(reviewsData.error?.message || 'Erreur API Google Reviews');
  }

  const starMap = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
  const reviews = reviewsData.reviews || [];

  for (const rev of reviews) {
    const reviewId = rev.reviewId || rev.name;
    const reviewerName = rev.reviewer?.displayName || 'Client Google';
    const stars = starMap[rev.starRating] || 5;
    const comment = rev.comment || '';
    const replyComment = rev.reviewReply?.comment || null;
    const updatedAt = rev.updateTime || rev.createTime || new Date().toISOString();

    await env.DB.prepare(`
      INSERT INTO google_reviews (review_id, client_id, reviewer_name, star_rating, comment, reply_comment, review_updated_at, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(review_id) DO UPDATE SET
        star_rating = excluded.star_rating,
        comment = excluded.comment,
        reply_comment = excluded.reply_comment,
        review_updated_at = excluded.review_updated_at,
        synced_at = CURRENT_TIMESTAMP
    `).bind(reviewId, client.id, reviewerName, stars, comment, replyComment, updatedAt).run();
  }
}

async function syncAllConnectedClientsReviews(env) {
  await ensureDatabaseReady(env.DB);
  const { results: clients } = await env.DB.prepare(
    'SELECT * FROM clients WHERE google_refresh_token IS NOT NULL'
  ).all();

  for (const client of clients) {
    try {
      await syncReviewsForClient(client, env);
    } catch (e) {
      // On continue avec le client suivant
    }
  }
}

function parseDateParts(dateStr) {
  const d = dateStr ? new Date(dateStr) : new Date();
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate()
  };
}

async function handleCreateGooglePostRoute(request, env) {
  const formData = await request.formData();
  const clientId = formData.get('client_id');
  const topicType = formData.get('topic_type') || 'STANDARD';
  const eventTitle = (formData.get('event_title') || '').trim();
  const startDate = (formData.get('start_date') || '').trim();
  const endDate = (formData.get('end_date') || '').trim();
  const couponCode = (formData.get('coupon_code') || '').trim();
  const summary = (formData.get('summary') || '').trim();
  let ctaUrl = (formData.get('cta_url') || '').trim();
  let mediaUrl = (formData.get('media_url') || '').trim();
  const useClientCover = formData.get('use_client_cover') === '1';
  const actionType = formData.get('action_type') || 'LEARN_MORE';

  if (!clientId || !summary) {
    return Response.redirect(new URL('/?msg=error_fields', request.url), 302);
  }

  const client = await env.DB.prepare('SELECT * FROM clients WHERE id = ?').bind(clientId).first();
  if (!client || !client.google_refresh_token) {
    return Response.redirect(new URL('/?msg=google_not_connected', request.url), 302);
  }

  if (!ctaUrl && client.heyzine_url) {
    ctaUrl = client.heyzine_url;
  }
  if (!mediaUrl && useClientCover && client.cover_photo_url) {
    mediaUrl = client.cover_photo_url;
  }

  try {
    const accessToken = await getGoogleAccessToken(client.google_refresh_token, env);

    let accountName = client.google_account_name;
    let locationName = client.google_location_name;
    if (!accountName || !locationName) {
      const allLocs = await listAllGoogleLocations(accessToken);
      if (allLocs.length > 0) {
        accountName = allLocs[0].accountName;
        locationName = allLocs[0].locationName;
      }
    }

    const fullResource = normalizeFullLocationResource(accountName, locationName);
    if (!fullResource) {
      return Response.redirect(new URL('/?msg=google_api_error', request.url), 302);
    }

    const postBody = {
      languageCode: 'fr-CA',
      summary,
      topicType
    };

    if (topicType === 'EVENT' || topicType === 'OFFER') {
      const start = parseDateParts(startDate);
      const end = parseDateParts(endDate || startDate);
      postBody.event = {
        title: eventTitle || `${client.business_name} — ${topicType === 'OFFER' ? 'Offre spéciale' : 'Événement'}`,
        schedule: {
          startDate: start,
          endDate: end
        }
      };
    }

    if (topicType === 'OFFER' && (couponCode || ctaUrl)) {
      postBody.offer = {
        ...(couponCode ? { couponCode } : {}),
        ...(ctaUrl ? { redeemOnlineUrl: ctaUrl } : {})
      };
    }

    if (ctaUrl && topicType !== 'OFFER') {
      postBody.callToAction = {
        actionType,
        url: ctaUrl
      };
    }

    if (mediaUrl) {
      postBody.media = [
        {
          mediaFormat: 'PHOTO',
          sourceUrl: mediaUrl
        }
      ];
    }

    const postRes = await fetch(
      `https://mybusiness.googleapis.com/v4/${fullResource}/localPosts`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(postBody)
      }
    );

    const postData = await postRes.json();
    if (!postRes.ok) {
      return Response.redirect(new URL('/?msg=google_api_error', request.url), 302);
    }

    await env.DB.prepare(`
      INSERT INTO google_posts (client_id, google_post_name, topic_type, summary, cta_url, media_url)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(client.id, postData.name || null, topicType, summary, ctaUrl || null, mediaUrl || null).run();

    return Response.redirect(new URL('/?msg=post_published', request.url), 302);
  } catch (e) {
    return Response.redirect(new URL('/?msg=google_api_error', request.url), 302);
  }
}

// ============================================================================
// AUTHENTIFICATION & GESTION COMPLÈTE DES ENTREPRENEURS / AGENDAS / MÉDIAS
// ============================================================================

async function handleLogin(request, env) {
  if (!env.MASTER_ADMIN_PASSWORD) {
    return new Response(renderLoginHTML('Variable MASTER_ADMIN_PASSWORD manquante dans Cloudflare.'), {
      status: 500,
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }

  const formData = await request.formData();
  const inputPassword = formData.get('password') || '';

  let valid = false;

  if (timingSafeEqual(inputPassword, env.MASTER_ADMIN_PASSWORD)) {
    valid = true;
  }

  if (!valid) {
    const stored = await env.DB.prepare(
      "SELECT value FROM admin_settings WHERE key = 'team_password_hash'"
    ).first();

    if (stored && stored.value) {
      valid = await verifyPasswordHash(inputPassword, stored.value);
    }
  }

  if (!valid) {
    return new Response(renderLoginHTML('Mot de passe invalide.'), {
      status: 401,
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }

  const secret = env.SESSION_SECRET || env.MASTER_ADMIN_PASSWORD;
  const token = await createSessionToken(secret);

  return new Response(null, {
    status: 302,
    headers: {
      'Location': '/',
      'Set-Cookie': `pd_session=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200`
    }
  });
}

async function handleChangePassword(request, env) {
  const formData = await request.formData();
  const newPassword = (formData.get('new_password') || '').trim();
  const confirmPassword = (formData.get('confirm_password') || '').trim();

  if (newPassword.length < 8 || newPassword !== confirmPassword) {
    return Response.redirect(new URL('/?msg=error_pwd', request.url), 302);
  }

  const hashed = await hashPassword(newPassword);

  await env.DB.prepare(`
    INSERT INTO admin_settings (key, value, updated_at)
    VALUES ('team_password_hash', ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).bind(hashed).run();

  return Response.redirect(new URL('/?msg=pwd_updated', request.url), 302);
}

async function handleAddClient(request, env) {
  const formData = await request.formData();
  const businessName = (formData.get('business_name') || '').trim();
  const city = (formData.get('city') || '').trim();
  const category = (formData.get('category') || '').trim();
  const phone = (formData.get('phone') || '').trim();
  const clientEmail = (formData.get('client_email') || '').trim();
  const bookingCalendarUrl = (formData.get('booking_calendar_url') || '').trim();
  const bookingNotes = (formData.get('booking_notes') || '').trim();
  const heyzineUrl = (formData.get('heyzine_url') || '').trim();
  const interviewVideoUrl = (formData.get('interview_video_url') || '').trim();
  const coverPhotoUrl = (formData.get('cover_photo_url') || '').trim();
  const rawGallery = (formData.get('gallery_urls') || '').trim();
  const galleryJson = JSON.stringify(rawGallery.split(',').map(s => s.trim()).filter(Boolean).slice(0, 5));

  if (!businessName || !city || !category) {
    return Response.redirect(new URL('/?msg=error_fields', request.url), 302);
  }

  await env.DB.prepare(`
    INSERT INTO clients (
      business_name, city, category, phone, client_email, booking_calendar_url,
      booking_notes, heyzine_url, interview_video_url, cover_photo_url, gallery_urls
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    businessName, city, category, phone, clientEmail, bookingCalendarUrl,
    bookingNotes, heyzineUrl, interviewVideoUrl, coverPhotoUrl, galleryJson
  ).run();

  return Response.redirect(new URL('/?msg=client_added', request.url), 302);
}

async function handleUpdateClientFull(request, env) {
  const formData = await request.formData();
  const clientId = formData.get('client_id');
  const businessName = (formData.get('business_name') || '').trim();
  const city = (formData.get('city') || '').trim();
  const category = (formData.get('category') || '').trim();
  const phone = (formData.get('phone') || '').trim();
  const clientEmail = (formData.get('client_email') || '').trim();
  const bookingCalendarUrl = (formData.get('booking_calendar_url') || '').trim();
  const bookingNotes = (formData.get('booking_notes') || '').trim();
  const heyzineUrl = (formData.get('heyzine_url') || '').trim();
  const interviewVideoUrl = (formData.get('interview_video_url') || '').trim();
  const coverPhotoUrl = (formData.get('cover_photo_url') || '').trim();
  const rawGallery = (formData.get('gallery_urls') || '').trim();
  const galleryJson = JSON.stringify(rawGallery.split(',').map(s => s.trim()).filter(Boolean).slice(0, 5));

  if (!clientId || !businessName || !city || !category) {
    return Response.redirect(new URL('/?msg=error_fields', request.url), 302);
  }

  await env.DB.prepare(`
    UPDATE clients
    SET business_name = ?,
        city = ?,
        category = ?,
        phone = ?,
        client_email = ?,
        booking_calendar_url = ?,
        booking_notes = ?,
        heyzine_url = ?,
        interview_video_url = ?,
        cover_photo_url = ?,
        gallery_urls = ?
    WHERE id = ?
  `).bind(
    businessName, city, category, phone, clientEmail, bookingCalendarUrl,
    bookingNotes, heyzineUrl, interviewVideoUrl, coverPhotoUrl, galleryJson, clientId
  ).run();

  return Response.redirect(new URL('/?msg=media_updated', request.url), 302);
}

async function handleDeleteClient(request, env) {
  const formData = await request.formData();
  const id = formData.get('id');
  if (id) {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM google_reviews WHERE client_id = ?').bind(id),
      env.DB.prepare('DELETE FROM google_posts WHERE client_id = ?').bind(id),
      env.DB.prepare('DELETE FROM heyzine_leads WHERE client_id = ?').bind(id),
      env.DB.prepare('DELETE FROM appointments WHERE client_id = ?').bind(id),
      env.DB.prepare('DELETE FROM clients WHERE id = ?').bind(id)
    ]);
  }
  return Response.redirect(new URL('/?msg=client_deleted', request.url), 302);
}

// ============================================================================
// CRYPTOGRAPHIE WEB STANDARD (PBKDF2 & HMAC)
// ============================================================================

async function hashPassword(password) {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const derivedBits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  return `${bufferToHex(salt)}:${bufferToHex(new Uint8Array(derivedBits))}`;
}

async function verifyPasswordHash(password, storedValue) {
  const [saltHex, originalHashHex] = storedValue.split(':');
  if (!saltHex || !originalHashHex) return false;
  const enc = new TextEncoder();
  const salt = hexToBuffer(saltHex);
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const derivedBits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  return timingSafeEqual(bufferToHex(new Uint8Array(derivedBits)), originalHashHex);
}

async function createSessionToken(secret) {
  const expires = Date.now() + 43200 * 1000;
  const payload = `admin:${expires}`;
  const sig = await signHmac(payload, secret);
  return `${payload}.${sig}`;
}

async function verifySession(request, env) {
  const secret = env.SESSION_SECRET || env.MASTER_ADMIN_PASSWORD;
  if (!secret) return false;

  const cookieHeader = request.headers.get('Cookie') || '';
  const match = cookieHeader.match(/pd_session=([^;]+)/);
  if (!match) return false;

  const token = match[1];
  const lastDot = token.lastIndexOf('.');
  if (lastDot === -1) return false;

  const payload = token.slice(0, lastDot);
  const sig = token.slice(lastDot + 1);
  const expectedSig = await signHmac(payload, secret);

  if (!timingSafeEqual(sig, expectedSig)) return false;

  const expires = parseInt(payload.split(':')[1], 10);
  return Date.now() < expires;
}

async function signHmac(data, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return bufferToHex(new Uint8Array(sig));
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function bufferToHex(buf) {
  return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
}

function hexToBuffer(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ============================================================================
// HEAD & ASSETS PARTAGÉS (/images/FavIcon.png, /css/index.css, /js/starry-bg.js)
// ============================================================================

function renderSharedHead(title) {
  return `
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
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
    body { font-family:'Outfit',system-ui,sans-serif; background:var(--bg-deep); color:var(--text); line-height:1.6; min-height:100vh; overflow-x:hidden; }
    a { color:var(--primary-light); text-decoration:none; }
    button { cursor:pointer; font-family:inherit; border:none; outline:none; color:inherit; }
    .display { font-family:'Cormorant Garamond',Georgia,serif; font-weight:700; letter-spacing:.3px; }
    #starry-canvas { position:fixed; inset:0; width:100%; height:100%; z-index:0; pointer-events:none; }
    .aura {
      position:fixed; inset:0; z-index:0; pointer-events:none;
      background:
        radial-gradient(60% 40% at 80% 6%,rgba(123,92,255,.2),transparent 60%),
        radial-gradient(50% 40% at 10% 24%,rgba(79,163,255,.12),transparent 60%),
        radial-gradient(70% 50% at 50% 112%,rgba(244,200,66,.06),transparent 60%);
    }
    .app-layer { position:relative; z-index:1; }
    .site-header {
      position:sticky; top:0; z-index:20; display:flex; align-items:center; justify-content:space-between; gap:16px;
      padding:14px clamp(16px,4vw,34px); border-bottom:1px solid rgba(123,92,255,.18);
      backdrop-filter:blur(14px); -webkit-backdrop-filter:blur(14px); background:rgba(6,10,24,.76); flex-wrap:wrap;
    }
    .brand { display:flex; align-items:center; gap:12px; color:#fff; font-weight:600; }
    .brand img { width:44px; height:44px; border-radius:50%; object-fit:cover; object-position:top; border:2px solid rgba(244,200,66,.55); box-shadow:0 0 22px rgba(123,92,255,.45); }
    .brand-name { display:flex; flex-direction:column; line-height:1.15; }
    .brand-name b { font-family:'Cormorant Garamond',Georgia,serif; font-size:1.35rem; color:var(--gold); letter-spacing:.03em; }
    .brand-name span { font-size:.72rem; color:var(--text-muted); letter-spacing:.5px; text-transform:uppercase; }
    .header-right { display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
    .webhook-pill { background:rgba(14,20,48,.85); border:1px solid rgba(123,92,255,.35); padding:6px 13px; border-radius:50px; font-size:.76rem; color:#C4B5FD; }
    .btn-primary {
      padding:10px 20px; border-radius:var(--radius-sm);
      background:linear-gradient(135deg,var(--primary),var(--secondary));
      color:#fff; font-size:.86rem; font-weight:600; white-space:nowrap;
      box-shadow:0 4px 16px var(--primary-glow); transition:transform var(--transition),box-shadow var(--transition);
    }
    .btn-primary:hover { transform:translateY(-1px); box-shadow:0 6px 26px var(--primary-glow); color:#fff; }
    .btn-gold {
      padding:10px 20px; border-radius:var(--radius-sm);
      background:linear-gradient(135deg,#F4C842,#C9A24A);
      color:#060a18; font-size:.86rem; font-weight:700; white-space:nowrap;
    }
    .btn-ghost {
      padding:9px 16px; border-radius:var(--radius-sm); white-space:nowrap;
      background:rgba(123,92,255,.12); border:1px solid var(--border);
      color:var(--text); font-size:.84rem; font-weight:600; transition:all var(--transition);
    }
    .btn-ghost:hover { border-color:var(--primary); background:rgba(123,92,255,.22); color:#fff; }
    .admin-wrap { max-width: 1380px; margin: 0 auto; padding: 26px clamp(16px, 3vw, 32px) 64px; display:grid; gap:22px; }
    .kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 16px; }
    .kpi-box { background: linear-gradient(145deg, rgba(14, 20, 48, 0.88), rgba(20, 27, 61, 0.6)); border: 1px solid var(--border); border-radius: var(--radius); padding: 18px 20px; backdrop-filter:blur(12px); }
    .kpi-label { font-size: .76rem; text-transform: uppercase; letter-spacing: .8px; color: var(--text-muted); }
    .kpi-val { font-family: 'Cormorant Garamond', serif; font-size: 2.3rem; font-weight: 700; color: var(--gold); line-height: 1.1; margin-top: 6px; }
    .grid-3 { display:grid; grid-template-columns: 1fr 1.1fr 1fr; gap:20px; }
    .grid-2 { display:grid; grid-template-columns: 1fr 1fr; gap:20px; }
    @media(max-width:1100px){ .grid-3, .grid-2 { grid-template-columns:1fr; } }
    .panel { background:rgba(14,20,48,0.78); backdrop-filter:blur(14px); -webkit-backdrop-filter:blur(14px); border:1px solid var(--border); border-radius:var(--radius); padding:22px; overflow-x:auto; box-shadow:var(--shadow-glow); }
    .panel h2 { font-family:'Cormorant Garamond',Georgia,serif; font-size:1.55rem; color:var(--gold); letter-spacing:.02em; margin-bottom:14px; }
    input, select, textarea {
      width:100%; padding:10px 13px; border-radius:var(--radius-sm);
      border:1px solid rgba(123,92,255,0.28); background:rgba(6,10,24,0.85);
      color:var(--text); margin-bottom:10px; font-family:inherit; font-size:.87rem;
    }
    input:focus, select:focus, textarea:focus { outline:none; border-color:var(--gold); box-shadow:0 0 0 3px rgba(244,200,66,.15); }
    button.draft-btn { background:rgba(244,200,66,0.14); border:1px solid rgba(244,200,66,0.45); color:var(--gold); width:100%; margin-bottom:10px; padding:10px; border-radius:var(--radius-sm); font-size:.85rem; font-weight:600; }
    button.draft-btn:hover { background:var(--gold); color:#060A18; }
    button.sync-btn { background:rgba(52,211,153,0.14); border:1px solid rgba(52,211,153,0.4); color:var(--green); padding:6px 11px; border-radius:8px; font-size:.76rem; font-weight:600; }
    button.sync-btn:hover { background:var(--green); color:#060A18; }
    button.copy-wh-btn { background:rgba(123,92,255,0.16); border:1px solid rgba(123,92,255,0.45); color:#C4B5FD; padding:6px 11px; border-radius:8px; font-size:.76rem; font-weight:600; }
    button.nyxia-reply-btn { background:linear-gradient(135deg, #7B5CFF, #5B3FD9); color:#fff; padding:8px 14px; border-radius:9px; font-size:.8rem; font-weight:600; width:100%; }
    button.del-btn { background:rgba(239,68,68,0.12); border:1px solid rgba(239,68,68,0.35); color:#FCA5A5; padding:6px 11px; border-radius:8px; font-size:.76rem; }
    table { width:100%; border-collapse:collapse; font-size:.87rem; }
    th, td { text-align:left; padding:12px; border-bottom:1px solid rgba(123,92,255,0.14); vertical-align:top; }
    th { color:var(--gold); font-size:.75rem; text-transform:uppercase; letter-spacing:.6px; font-weight:600; }
    .badge { background:#1E293B; padding:4px 11px; border-radius:99px; font-size:.75rem; color:var(--gold); display:inline-block; font-weight:600; }
    .badge.connected { background:rgba(52,211,153,0.14); border:1px solid rgba(52,211,153,0.4); color:var(--green); }
    .cal-badge { display:inline-block; margin-top:6px; background:rgba(244,200,66,0.14); border:1px solid rgba(244,200,66,0.45); color:var(--gold); padding:4px 10px; border-radius:7px; font-size:.76rem; font-weight:600; }
    .cal-badge:hover { background:var(--gold); color:#060A18; }
    .gcal-btn { display:inline-block; background:linear-gradient(135deg,#F4C842,#C9A24A); color:#060A18; padding:7px 13px; border-radius:8px; font-size:.78rem; font-weight:700; }
    .oauth-btn { display:inline-block; background:rgba(123,92,255,0.16); border:1px solid #7B5CFF; color:#C4B5FD; padding:6px 12px; border-radius:8px; font-size:.8rem; font-weight:600; }
    .oauth-btn:hover { background:#7B5CFF; color:#fff; }
    .oauth-link { color:var(--text-secondary); font-size:.76rem; text-decoration:underline; }
    .alert { background:rgba(123,92,255,0.22); border:1px solid var(--gold); padding:13px 18px; border-radius:12px; color:#fff; font-size:.9rem; }
    .check-row { display:flex; align-items:center; gap:8px; font-size:.82rem; color:#C4B5FD; margin-bottom:10px; }
    .check-row input { width:auto; margin:0; }
    .modal-backdrop { position:fixed; inset:0; z-index:60; background:rgba(6,10,24,.84); backdrop-filter:blur(8px); display:none; align-items:center; justify-content:center; padding:20px; }
    .modal-backdrop.open { display:flex; }
    .modal-box { width:100%; max-width:740px; max-height:90vh; overflow-y:auto; background:var(--bg-card); border:1px solid rgba(123,92,255,.45); border-radius:var(--radius); padding:26px; box-shadow:0 24px 64px rgba(0,0,0,.7); }
    .field-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(210px, 1fr)); gap:12px; }
    .field label { display:block; font-size:.76rem; color:var(--text-secondary); margin-bottom:4px; }
  </style>`;
}

function renderBackgroundLayer() {
  return `
  <canvas id="starry-canvas"></canvas>
  <div class="aura"></div>
  <script src="${STARRY_JS_URL}" defer></script>`;
}

function renderErrorHTML(title, details) {
  return new Response(`<!DOCTYPE html>
<html lang="fr">
<head>${renderSharedHead(title)}</head>
<body>
  ${renderBackgroundLayer()}
  <div class="app-layer" style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;">
    <div class="panel" style="width:100%;max-width:620px;">
      <h2>${escapeHtml(title)}</h2>
      <pre style="white-space:pre-wrap;background:rgba(6,10,24,.9);border:1px solid var(--border);padding:14px;border-radius:10px;color:#fecaca;font-size:.82rem;margin-bottom:16px;">${escapeHtml(details)}</pre>
      <a href="/" class="btn-primary" style="display:inline-block;">Recharger la console</a>
    </div>
  </div>
</body>
</html>`, {
    status: 500,
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

// ============================================================================
// INTERFACES HTML (LOGIN, SÉLECTION FICHE AGENCE & DASHBOARD UNIFIÉ)
// ============================================================================

function renderLoginHTML(error = '') {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  ${renderSharedHead('SuperAdmin — Pont Digital • Univers NyXia')}
</head>
<body>
  ${renderBackgroundLayer()}
  <div class="app-layer" style="display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px;">
    <div class="panel" style="width:100%;max-width:410px;padding:36px 30px;text-align:center;">
      <div style="width:88px;height:88px;margin:0 auto 16px;border-radius:50%;padding:2px;background:linear-gradient(135deg,#7B5CFF,#F4C842);box-shadow:0 0 28px rgba(123,92,255,0.55);">
        <img src="${NYXIA_AVATAR_URL}" alt="NyXia" style="width:100%;height:100%;object-fit:cover;object-position:top;border-radius:50%;display:block;background:#060A18;">
      </div>
      <h1 class="display" style="font-size:1.95rem;color:var(--gold);margin-bottom:4px;">PONT DIGITAL • Admin</h1>
      <p style="color:var(--text-secondary);font-size:.9rem;margin-bottom:22px;">Poste de commandement réservé à l'équipe.</p>
      ${error ? `<div style="background:rgba(239,68,68,0.15);border:1px solid #EF4444;color:#FCA5A5;padding:10px;border-radius:10px;margin-bottom:14px;font-size:.85rem;">${escapeHtml(error)}</div>` : ''}
      <form method="POST" action="/login">
        <input type="password" name="password" placeholder="Mot de passe d'accès" required autofocus />
        <button type="submit" class="btn-primary" style="width:100%;padding:13px;font-size:.96rem;">Déverrouiller la console</button>
      </form>
    </div>
  </div>
</body>
</html>`;
}

function renderSelectLocationHTML(client, locations) {
  const optionsHtml = locations.map(loc => {
    const packed = `${loc.accountName}|||${loc.locationName}|||${loc.placeId}|||${loc.title}`;
    const displayCity = loc.cityLabel ? ` — ${loc.cityLabel}` : '';
    const displayGroup = loc.accountLabel ? ` [${loc.accountLabel}]` : '';
    return `<option value="${escapeHtml(packed)}" ${client.google_location_name === loc.locationName ? 'selected' : ''}>${escapeHtml(loc.title)}${escapeHtml(displayCity)}${escapeHtml(displayGroup)}</option>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="fr">
<head>
  ${renderSharedHead('Sélectionner la fiche Google — Pont Digital')}
</head>
<body>
  ${renderBackgroundLayer()}
  <div class="app-layer" style="display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px;">
    <div class="panel" style="width:100%;max-width:520px;padding:32px;">
      <h2>Compte Agence Google Détecté</h2>
      <p style="color:var(--text-secondary);font-size:.92rem;margin-bottom:18px;">
        Ce compte Google gère <strong>${locations.length} établissements</strong>.<br>
        Choisis exactement quelle fiche Google Business Profile associer à <strong>${escapeHtml(client.business_name)}</strong> (${escapeHtml(client.city)}) :
      </p>
      ${locations.length > 0
        ? `<form method="POST" action="/api/google/assign-location">
             <input type="hidden" name="client_id" value="${client.id}" />
             <select name="selected_location" required>
               ${optionsHtml}
             </select>
             <button type="submit" class="btn-primary" style="width:100%;padding:12px;">Associer cette fiche Google au client</button>
           </form>`
        : `<p style="color:#FCA5A5;">Aucune fiche Google Business Profile trouvée sur ce compte Google.</p>`
      }
      <a href="/" style="display:block;text-align:center;margin-top:14px;color:var(--text-secondary);font-size:.85rem;">← Retour au tableau de bord</a>
    </div>
  </div>
</body>
</html>`;
}

function renderDashboardHTML(clients, recentReviews, recentLeads, recentAppointments, msg, origin) {
  const alerts = {
    pwd_updated: 'Mot de passe interne mis à jour avec succès dans D1.',
    error_pwd: 'Erreur : le mot de passe doit contenir au moins 8 caractères et être identique.',
    client_added: 'Entrepreneur ajouté à la base D1 Pont Digital avec son agenda et son dossier média.',
    media_updated: 'Fiche entrepreneur, Agenda Workspace & Médias mis à jour !',
    client_deleted: 'Fiche entrepreneur et données associées supprimées.',
    error_fields: 'Veuillez remplir les champs obligatoires.',
    google_connected: 'Fiche Google Business Profile connectée avec succès !',
    google_location_assigned: 'Établissement Google Agence associé avec succès à cet entrepreneur !',
    google_oauth_error: 'La connexion Google Business Profile a échoué ou a été annulée.',
    google_missing_keys: 'Configuration requise : ajoute GOOGLE_CLIENT_ID et GOOGLE_CLIENT_SECRET dans Cloudflare.',
    google_not_connected: 'Connecte d’abord la fiche Google GBP de ce client avant de synchroniser ou publier.',
    reviews_synced: 'Avis Google synchronisés et enregistrés dans la base D1 !',
    review_replied: 'Réponse optimisée générée par NyXia et publiée officiellement sur Google Maps !',
    post_published: 'Publication diffusée avec succès sur la fiche Google Business Profile du client !',
    google_api_error: 'Erreur de communication avec l’API Google Business Profile.',
    lead_processed: 'Alerte Setter générée par NyXia : SMS envoyé vers ton cellulaire d’agence (AGENCY_ALERT_PHONE) et lead enregistré dans D1.',
    lead_status_updated: 'Statut de suivi du lead mis à jour.',
    rdv_booked: 'Rendez-vous qualifié enregistré ! Clique sur « 📅 Envoyer l’invitation Google Agenda » ci-dessous pour notifier instantanément le client et le prospect.',
    rdv_deleted: 'Rendez-vous retiré du journal.'
  };

  const gbpConnectedCount = clients.filter(c => Boolean(c.google_refresh_token)).length;
  const bookingReadyCount = clients.filter(c => Boolean(c.booking_calendar_url)).length;
  const pendingReviewsCount = recentReviews.filter(r => !r.reply_comment).length;

  const connectedClients = clients.filter(c => Boolean(c.google_refresh_token));
  const connectedOptions = connectedClients.map(c =>
    `<option value="${c.id}">${escapeHtml(c.business_name)} (${escapeHtml(c.city)})</option>`
  ).join('');

  const allClientOptions = clients.map(c =>
    `<option value="${c.id}">${escapeHtml(c.business_name)} (${escapeHtml(c.city)})</option>`
  ).join('');

  const rows = clients.map(c => {
    const isConnected = Boolean(c.google_refresh_token);
    const webhookClientUrl = `${origin}/webhook/heyzine?client_id=${c.id}`;
    let photosCount = 0;
    try { photosCount = JSON.parse(c.gallery_urls || '[]').length; } catch (_) {}

    return `
    <tr>
      <td>
        <div style="display:flex;align-items:flex-start;gap:10px;">
          ${c.cover_photo_url ? `<img src="${escapeHtml(c.cover_photo_url)}" alt="" style="width:42px;height:42px;border-radius:10px;object-fit:cover;border:1px solid var(--border);flex-shrink:0;">` : ''}
          <div>
            <strong style="color:#fff;font-size:.96rem;">${escapeHtml(c.business_name)}</strong> <span style="color:var(--gold); font-size:0.75rem;">#${c.id}</span><br>
            <span style="font-size:0.78rem; color:var(--text-secondary);">${escapeHtml(c.city)} • ${escapeHtml(c.category)}</span><br>
            <span style="font-size:0.74rem; color:var(--text-muted);">${c.rdv_count || 0} RDV • ${c.lead_count || 0} leads • ${c.review_count || 0} avis • ${photosCount} photo(s) galerie</span>
            ${c.booking_notes ? `<div style="font-size:.75rem;color:#C4B5FD;margin-top:4px;max-width:260px;">📝 ${escapeHtml(c.booking_notes)}</div>` : ''}
          </div>
        </div>
      </td>
      <td>
        ${c.booking_calendar_url
          ? `<span class="badge connected">● Agenda Google prêt</span><br>
             <a href="${escapeHtml(c.booking_calendar_url)}" target="_blank" rel="noopener" class="cal-badge">📅 Voir disponibilités Workspace ↗</a>`
          : `<span class="badge">○ Agenda à configurer</span>`
        }
        ${c.client_email ? `<div style="font-size:.75rem;color:var(--text-secondary);margin-top:5px;">✉️ ${escapeHtml(c.client_email)}</div>` : ''}
        <div style="margin-top:7px;">
          <button type="button" class="copy-wh-btn" onclick="copyWebhook('${escapeHtml(webhookClientUrl)}', this)" title="URL exacte à coller dans le formulaire Heyzine de ce client">📋 Webhook Heyzine #${c.id}</button>
        </div>
      </td>
      <td>
        ${isConnected
          ? `<div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap;">
               <span class="badge connected">● ${escapeHtml(c.google_location_title || 'GBP Actif')}</span>
               <form method="POST" action="/api/google/sync-reviews" style="margin:0;">
                 <input type="hidden" name="client_id" value="${c.id}" />
                 <button type="submit" class="sync-btn">↻ Sync Avis</button>
               </form>
               <a href="/oauth/google/select-location?client_id=${c.id}" class="oauth-link">Changer fiche</a>
               <a href="/oauth/google/connect?client_id=${c.id}" class="oauth-link">Réauth</a>
             </div>`
          : `<a href="/oauth/google/connect?client_id=${c.id}" class="oauth-btn">🔗 Connecter Google GBP</a>`
        }
      </td>
      <td>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          <button type="button" class="btn-ghost" style="padding:6px 12px;font-size:.78rem;" onclick='openEditModal(${JSON.stringify(c).replace(/'/g, "&#39;")})'>✏️ Modifier</button>
          <form method="POST" action="/api/clients/delete" style="margin:0;" onsubmit="return confirm('Supprimer définitivement cette fiche ?');">
            <input type="hidden" name="id" value="${c.id}" />
            <button type="submit" class="del-btn">🗑️</button>
          </form>
        </div>
      </td>
    </tr>
  `;
  }).join('');

  const appointmentCards = recentAppointments.map(a => `
    <div style="background:rgba(6,10,24,0.78); border:1px solid rgba(244,200,66,0.32); border-radius:12px; padding:14px; margin-bottom:12px;">
      <div style="display:flex; justify-content:space-between; font-size:0.84rem; margin-bottom:6px; gap:8px; flex-wrap:wrap;">
        <strong style="color:var(--gold);">${escapeHtml(a.business_name)} (${escapeHtml(a.city)})</strong>
        <span style="color:var(--green);font-weight:600;">📅 ${escapeHtml(a.appointment_datetime.replace('T', ' '))} (${a.duration_minutes} min)</span>
      </div>
      <div style="font-size:0.85rem; color:#fff; margin-bottom:6px;">
        Prospect qualifié : <strong>${escapeHtml(a.prospect_name)}</strong>
        ${a.prospect_phone ? `• 📞 ${escapeHtml(a.prospect_phone)}` : ''}
        ${a.prospect_email ? `• ✉️ ${escapeHtml(a.prospect_email)}` : ''}
      </div>
      ${a.setter_notes ? `<div style="font-size:0.8rem; color:var(--text-secondary); margin-bottom:8px;">Notes : ${escapeHtml(a.setter_notes)}</div>` : ''}
      <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
        <a href="${escapeHtml(a.gcal_event_url)}" target="_blank" rel="noopener" class="gcal-btn">📅 Envoyer l’invitation Google Agenda ↗</a>
        ${a.booking_calendar_url ? `<a href="${escapeHtml(a.booking_calendar_url)}" target="_blank" rel="noopener" class="oauth-link">Ouvrir page réservation client</a>` : ''}
        <form method="POST" action="/api/setter/delete" style="margin:0;margin-left:auto;">
          <input type="hidden" name="id" value="${a.id}" />
          <button type="submit" class="del-btn" title="Retirer">✕</button>
        </form>
      </div>
    </div>
  `).join('');

  const leadCards = recentLeads.map(l => {
    const smsBadge = l.sms_status === 'sent'
      ? '<span style="color:var(--green);font-weight:600;">✓ SMS reçu par l’agence</span>'
      : `<span style="color:var(--gold);">${escapeHtml(l.sms_status)}</span>`;
    const st = l.handling_status || 'nouveau';
    return `
      <div style="background:rgba(6,10,24,0.78); border:1px solid rgba(123,92,255,0.25); border-radius:12px; padding:14px; margin-bottom:12px;">
        <div style="display:flex; justify-content:space-between; font-size:0.82rem; margin-bottom:6px; gap:8px; flex-wrap:wrap;">
          <strong style="color:var(--gold);">Client : ${escapeHtml(l.business_name || 'Non associé')}</strong>
          ${smsBadge}
        </div>
        <div style="font-size:0.84rem; color:var(--text-secondary); margin-bottom:6px;">
          Prospect à appeler : <strong style="color:#fff;">${escapeHtml(l.prospect_name)}</strong> (${escapeHtml(l.prospect_contact)})
        </div>
        <div style="font-size:0.81rem; color:#C4B5FD; background:rgba(14,20,48,0.9); padding:9px 12px; border-radius:8px; border-left:3px solid #7B5CFF; margin-bottom:8px;">
          <strong>Alerte SMS NyXia :</strong> ${escapeHtml(l.nyxia_sms_text || '')}
        </div>
        <form method="POST" action="/api/leads/status" style="margin:0; display:flex; gap:8px; align-items:center;">
          <input type="hidden" name="lead_id" value="${l.id}" />
          <select name="handling_status" style="margin:0; padding:6px 10px; font-size:0.8rem; flex:1;">
            <option value="nouveau" ${st === 'nouveau' ? 'selected' : ''}>🔴 Nouveau — À appeler d’urgence</option>
            <option value="en_cours" ${st === 'en_cours' ? 'selected' : ''}>🟡 Pris en charge par le Setter</option>
            <option value="rdv_confirme" ${st === 'rdv_confirme' ? 'selected' : ''}>🟢 RDV confirmé dans l’agenda client</option>
          </select>
          <button type="submit" class="sync-btn">Mettre à jour</button>
        </form>
      </div>
    `;
  }).join('');

  const reviewCards = recentReviews.map(r => {
    const hasReply = Boolean(r.reply_comment);
    const canReply = Boolean(r.google_refresh_token);
    return `
    <div style="background:rgba(6,10,24,0.78); border:1px solid rgba(244,200,66,0.22); border-radius:12px; padding:14px; margin-bottom:12px;">
      <div style="display:flex; justify-content:space-between; font-size:0.84rem; margin-bottom:4px;">
        <strong style="color:var(--gold);">${escapeHtml(r.business_name)}</strong>
        <span style="color:#FBBF24;">${'★'.repeat(r.star_rating || 5)}</span>
      </div>
      <div style="font-size:0.8rem; color:var(--text-muted); margin-bottom:6px;">Par ${escapeHtml(r.reviewer_name)}</div>
      <div style="font-size:0.86rem; color:#E2E8F0; margin-bottom:10px;">${escapeHtml(r.comment || '(Note sans commentaire)')}</div>
      ${hasReply
        ? `<div style="font-size:0.81rem; color:var(--green); background:rgba(14,20,48,0.9); padding:9px 12px; border-radius:8px; border-left:3px solid var(--green);">
             <strong>✓ Réponse publiée :</strong> ${escapeHtml(r.reply_comment)}
           </div>`
        : (canReply
            ? `<form method="POST" action="/api/google/reply-review" style="margin:0;">
                 <input type="hidden" name="review_id" value="${escapeHtml(r.review_id)}" />
                 <button type="submit" class="nyxia-reply-btn">✨ Répondre via NyXia &amp; Publier sur Google</button>
               </form>`
            : `<span style="font-size:0.76rem; color:var(--text-muted);">Fiche Google non connectée pour répondre</span>`)
      }
    </div>
  `;
  }).join('');

  return `<!DOCTYPE html>
<html lang="fr">
<head>
  ${renderSharedHead('SuperAdmin • Pont Digital • NyXia')}
</head>
<body>
  ${renderBackgroundLayer()}
  <div class="app-layer">
    <header class="site-header">
      <a href="/" class="brand">
        <img src="${NYXIA_AVATAR_URL}" alt="NyXia">
        <div class="brand-name">
          <b>PONT DIGITAL • SuperAdmin</b>
          <span>Setter, Agendas Workspace, Heyzine &amp; Google GBP</span>
        </div>
      </a>
      <div class="header-right">
        <div class="webhook-pill">Agence Setter • Webhook Heyzine &amp; SMS Actifs</div>
        <a href="/logout" class="btn-ghost">Déconnexion</a>
      </div>
    </header>

    <main class="admin-wrap">
      ${msg && alerts[msg] ? `<div class="alert">${alerts[msg]}</div>` : ''}

      <!-- KPI BAR (DISPOSITION WORKER 2) -->
      <div class="kpi-grid">
        <div class="kpi-box">
          <div class="kpi-label">Entrepreneurs actifs</div>
          <div class="kpi-val">${clients.length}</div>
        </div>
        <div class="kpi-box">
          <div class="kpi-label">Agendas Workspace prêts</div>
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

      <!-- 3 COLONNES PRINCIPALES (FONCTIONS WORKER 1) -->
      <div class="grid-3">
        <div class="panel">
          <h2>+ Nouvel entrepreneur &amp; Agenda</h2>
          <form method="POST" action="/api/clients">
            <input type="text" name="business_name" placeholder="Nom de l'entreprise *" required />
            <input type="text" name="city" placeholder="Ville / Région *" required />
            <input type="text" name="category" placeholder="Métier / Spécialité *" required />
            <input type="text" name="phone" placeholder="Téléphone public de l'entreprise" />
            <input type="email" name="client_email" placeholder="Courriel client / vendeur (invitations RDV)" />
            <input type="url" name="booking_calendar_url" placeholder="Lien Page Réservation Google Workspace" />
            <input type="text" name="booking_notes" placeholder="Consignes setters (critères qualification, secteur...)" />
            <input type="url" name="heyzine_url" placeholder="URL Page Heyzine du client (#page/X)" />
            <input type="url" name="interview_video_url" placeholder="URL Vidéo entrevue (YouTube/Vimeo/MP4)" />
            <input type="url" name="cover_photo_url" placeholder="URL Photo couverture principale" />
            <input type="text" name="gallery_urls" placeholder="Photos galerie (jusqu'à 5 URLs séparées par virgule)" />
            <button type="submit" class="btn-primary" style="width:100%;">Créer la fiche verrouillée D1</button>
          </form>
        </div>

        <div class="panel">
          <h2>📅 Setter • Booker un RDV qualifié</h2>
          <form method="POST" action="/api/setter/book">
            <select name="client_id" required>
              <option value="">-- Pour quel entrepreneur client ? --</option>
              ${allClientOptions}
            </select>
            <input type="text" name="prospect_name" placeholder="Nom du prospect qualifié *" required />
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px;">
              <input type="text" name="prospect_phone" placeholder="Téléphone prospect" />
              <input type="email" name="prospect_email" placeholder="Courriel prospect" />
            </div>
            <div style="display:grid; grid-template-columns:1.4fr 0.6fr; gap:8px;">
              <input type="datetime-local" name="appointment_datetime" required title="Date et heure du rendez-vous" />
              <select name="duration_minutes" title="Durée du RDV">
                <option value="30">30 min</option>
                <option value="45">45 min</option>
                <option value="60">60 min</option>
              </select>
            </div>
            <textarea name="setter_notes" rows="3" placeholder="Notes de qualification pour le vendeur (besoin, budget, adresse)..."></textarea>
            <button type="submit" class="btn-gold" style="width:100%;">📅 Enregistrer le RDV &amp; Préparer l’invitation</button>
          </form>

          <hr style="border:0; border-top:1px solid rgba(123,92,255,0.2); margin:18px 0;">

          <h2>Tester Alerte SMS Setter</h2>
          <form method="POST" action="/api/test-nyxia-sms" style="margin:0;">
            <select name="client_id" required>
              <option value="">-- Prospect intéressé par quel client ? --</option>
              ${allClientOptions}
            </select>
            <input type="text" name="prospect_name" placeholder="Nom du prospect test" value="Sophie Gagnon" required />
            <input type="text" name="prospect_contact" placeholder="Tél ou courriel du prospect" value="450-555-0142" required />
            <input type="text" name="prospect_message" placeholder="Message du prospect" value="Intéressée par vos services suite à l'article Heyzine !" required />
            <button type="submit" class="btn-primary" style="width:100%;">Simuler un lead vers ton cellulaire</button>
          </form>
        </div>

        <div class="panel">
          <h2>Studio Publication Google (Multi-Formats)</h2>
          <form method="POST" action="/api/google/create-post" id="post-studio-form">
            <select name="client_id" id="post-client-select" required>
              <option value="">-- Sélectionner le client GBP (${connectedClients.length}) --</option>
              ${connectedOptions}
            </select>

            <select name="topic_type" id="post-topic-type" onchange="togglePostFields()">
              <option value="STANDARD">📰 Actualité / Reportage Vidéo Heyzine</option>
              <option value="OFFER">🎁 Offre Spéciale / Promotion</option>
              <option value="EVENT">📅 Événement / Portes Ouvertes</option>
            </select>

            <div id="event-offer-fields" style="display:none;">
              <input type="text" name="event_title" placeholder="Titre de l'offre ou de l'événement *" />
              <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px;">
                <input type="date" name="start_date" title="Date de début" />
                <input type="date" name="end_date" title="Date de fin" />
              </div>
              <input type="text" name="coupon_code" id="coupon-field" placeholder="Code promo (optionnel pour Offre)" />
            </div>

            <button type="button" class="draft-btn" id="btn-nyxia-draft" onclick="draftPostWithNyxia()">✨ Rédiger ce post sur mesure avec NyXia</button>

            <textarea name="summary" id="post-summary" rows="3" placeholder="Texte de la publication Google..." required></textarea>

            <input type="url" name="media_url" id="post-media-url" placeholder="URL Photo personnalisée (vide = photo du client)" />
            <label class="check-row">
              <input type="checkbox" name="use_client_cover" value="1" checked />
              Joindre automatiquement la photo enregistrée de ce client
            </label>

            <select name="action_type" id="post-action-type">
              <option value="LEARN_MORE">Bouton : En savoir plus (Revue Heyzine)</option>
              <option value="BOOK">Bouton : Réserver</option>
              <option value="CALL">Bouton : Appeler</option>
              <option value="SIGN_UP">Bouton : S'inscrire</option>
            </select>

            <input type="url" name="cta_url" id="post-cta-url" placeholder="Lien cible (vide = page Heyzine du client)" />
            <button type="submit" class="btn-primary" style="width:100%;">Publier sur la fiche Google du client</button>
          </form>
        </div>
      </div>

      <!-- RÉPERTOIRE DES ENTREPRENEURS (AVEC MODALE D'ÉDITION COMPLÈTE WORKER 2) -->
      <div class="panel">
        <h2>Entrepreneurs actifs, Agendas Workspace &amp; Médias Verrouillés (${clients.length})</h2>
        <table>
          <thead>
            <tr>
              <th>Entreprise &amp; Consignes</th>
              <th>Agenda Workspace &amp; Webhook Heyzine</th>
              <th>Google Business Profile</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${rows || '<tr><td colspan="4" style="color:var(--text-muted);text-align:center;padding:24px;">Aucun entrepreneur enregistré.</td></tr>'}
          </tbody>
        </table>
      </div>

      <!-- JOURNAL RDV & LEADS HEYZINE -->
      <div class="grid-2">
        <div class="panel">
          <h2>📅 Rendez-vous qualifiés livrés aux clients (${recentAppointments.length})</h2>
          ${appointmentCards || '<p style="color:var(--text-muted); font-size:0.9rem;">Utilise le module Setter ci-dessus pour booker un premier rendez-vous qualifié.</p>'}
        </div>

        <div class="panel">
          <h2>Leads entrants à qualifier par les Setters (${recentLeads.length})</h2>
          ${leadCards || '<p style="color:var(--text-muted); font-size:0.9rem;">Aucun prospect reçu depuis Heyzine Pro pour le moment.</p>'}
        </div>
      </div>

      <!-- AVIS GOOGLE & SÉCURITÉ ÉQUIPE -->
      <div class="grid-2">
        <div class="panel">
          <h2>Derniers avis Google synchronisés (${recentReviews.length})</h2>
          ${reviewCards || '<p style="color:var(--text-muted); font-size:0.9rem;">Clique sur « ↻ Sync Avis » sur un client connecté.</p>'}
        </div>

        <div class="panel">
          <h2>Sécurité • Mot de passe équipe</h2>
          <form method="POST" action="/api/change-password">
            <input type="password" name="new_password" placeholder="Nouveau mot de passe (min. 8 car.)" required />
            <input type="password" name="confirm_password" placeholder="Confirmer le mot de passe" required />
            <button type="submit" class="btn-gold">Mettre à jour le mot de passe</button>
          </form>
        </div>
      </div>
    </main>
  </div>

  <!-- MODALE D'ÉDITION COMPLÈTE D'UN ENTREPRENEUR (DISPOSITION WORKER 2) -->
  <div id="edit-modal" class="modal-backdrop">
    <div class="modal-box">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
        <h2 style="margin:0;">Modifier la fiche entrepreneur</h2>
        <button type="button" class="btn-ghost" style="padding:6px 12px;" onclick="closeEditModal()">✕ Fermer</button>
      </div>
      <form method="POST" action="/api/clients/update">
        <input type="hidden" name="client_id" id="edit-client_id" />
        <div class="field-grid">
          <div class="field"><label>Nom de l'entreprise *</label><input type="text" name="business_name" id="edit-business_name" required /></div>
          <div class="field"><label>Ville / Région *</label><input type="text" name="city" id="edit-city" required /></div>
          <div class="field"><label>Métier / Spécialité *</label><input type="text" name="category" id="edit-category" required /></div>
          <div class="field"><label>Téléphone</label><input type="text" name="phone" id="edit-phone" /></div>
          <div class="field"><label>Courriel vendeur (invitations RDV)</label><input type="email" name="client_email" id="edit-client_email" /></div>
          <div class="field"><label>Lien Page Réservation Google Workspace</label><input type="url" name="booking_calendar_url" id="edit-booking_calendar_url" /></div>
          <div class="field"><label>URL Page Heyzine (#page/X)</label><input type="url" name="heyzine_url" id="edit-heyzine_url" /></div>
          <div class="field"><label>URL Vidéo entrevue</label><input type="url" name="interview_video_url" id="edit-interview_video_url" /></div>
          <div class="field"><label>URL Photo couverture principale</label><input type="url" name="cover_photo_url" id="edit-cover_photo_url" /></div>
        </div>
        <div class="field" style="margin-top:4px;"><label>Consignes setters (qualification, secteur, script)</label><input type="text" name="booking_notes" id="edit-booking_notes" /></div>
        <div class="field"><label>Photos galerie (jusqu'à 5 URLs séparées par virgule)</label><input type="text" name="gallery_urls" id="edit-gallery_urls" /></div>
        <div style="margin-top:14px;display:flex;justify-content:flex-end;gap:10px;">
          <button type="button" class="btn-ghost" onclick="closeEditModal()">Annuler</button>
          <button type="submit" class="btn-primary">Enregistrer les modifications</button>
        </div>
      </form>
    </div>
  </div>

  <script>
    function openEditModal(c) {
      document.getElementById('edit-client_id').value = c.id;
      document.getElementById('edit-business_name').value = c.business_name || '';
      document.getElementById('edit-city').value = c.city || '';
      document.getElementById('edit-category').value = c.category || '';
      document.getElementById('edit-phone').value = c.phone || '';
      document.getElementById('edit-client_email').value = c.client_email || '';
      document.getElementById('edit-booking_calendar_url').value = c.booking_calendar_url || '';
      document.getElementById('edit-heyzine_url').value = c.heyzine_url || '';
      document.getElementById('edit-interview_video_url').value = c.interview_video_url || '';
      document.getElementById('edit-cover_photo_url').value = c.cover_photo_url || '';
      document.getElementById('edit-booking_notes').value = c.booking_notes || '';
      var photos = [];
      try { photos = JSON.parse(c.gallery_urls || '[]'); } catch (_) {}
      document.getElementById('edit-gallery_urls').value = photos.join(', ');
      document.getElementById('edit-modal').classList.add('open');
    }

    function closeEditModal() {
      document.getElementById('edit-modal').classList.remove('open');
    }

    function copyWebhook(url, btn) {
      navigator.clipboard.writeText(url).then(function() {
        var old = btn.textContent;
        btn.textContent = '✓ Copié !';
        setTimeout(function() { btn.textContent = old; }, 2000);
      });
    }

    function togglePostFields() {
      var type = document.getElementById('post-topic-type').value;
      var box = document.getElementById('event-offer-fields');
      var coupon = document.getElementById('coupon-field');
      var actionSel = document.getElementById('post-action-type');
      box.style.display = (type === 'OFFER' || type === 'EVENT') ? 'block' : 'none';
      coupon.style.display = (type === 'OFFER') ? 'block' : 'none';
      actionSel.style.display = (type === 'OFFER') ? 'none' : 'block';
    }

    async function draftPostWithNyxia() {
      var clientId = document.getElementById('post-client-select').value;
      var topicType = document.getElementById('post-topic-type').value;
      var btn = document.getElementById('btn-nyxia-draft');
      if (!clientId) {
        alert('Choisis d’abord un entrepreneur dans la liste déroulante.');
        return;
      }
      var oldLabel = btn.textContent;
      btn.disabled = true;
      btn.textContent = '⏳ NyXia rédige le post sur mesure...';
      try {
        var res = await fetch('/api/nyxia/draft-post', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ client_id: clientId, topic_type: topicType })
        });
        var data = await res.json();
        if (data.draft) {
          document.getElementById('post-summary').value = data.draft;
        }
        if (data.default_media && !document.getElementById('post-media-url').value) {
          document.getElementById('post-media-url').value = data.default_media;
        }
        if (data.default_cta && !document.getElementById('post-cta-url').value) {
          document.getElementById('post-cta-url').value = data.default_cta;
        }
      } catch (e) {
        alert('Erreur lors de la rédaction.');
      } finally {
        btn.disabled = false;
        btn.textContent = oldLabel;
      }
    }
  </script>
</body>
</html>`;
}
