// ============================================================================
// PONT DIGITAL — SUPER ADMIN WORKER UNIFIÉ (CLOUDFLARE WORKERS + D1)
// Visuel      : Disposition pleine largeur empilée du Worker 2
//               + /images/FavIcon.png (onglet) + /images/NyXia.png (avatar)
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

      // 12. Chargement des données et affichage du Tableau de Bord (Visuel Worker 2)
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
        LIMIT 25
      `).all();

      const { results: recentLeads } = await env.DB.prepare(`
        SELECT l.*, c.business_name
        FROM heyzine_leads l
        LEFT JOIN clients c ON c.id = l.client_id
        ORDER BY l.created_at DESC
        LIMIT 25
      `).all();

      const { results: recentAppointments } = await env.DB.prepare(`
        SELECT a.*, c.business_name, c.city, c.client_email, c.booking_calendar_url
        FROM appointments a
        JOIN clients c ON c.id = a.client_id
        ORDER BY a.created_at DESC
        LIMIT 25
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
// HEAD & ASSETS PARTAGÉS (DISPOSITION VISUELLE PLEINE LARGEUR DU WORKER 2)
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
    body { font-family:'Outfit',-apple-system,BlinkMacSystemFont,sans-serif; background:var(--bg-deep); color:var(--text); line-height:1.6; min-height:100vh; overflow-x:hidden; }
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
    .site-header {
      position:sticky; top:0; z-index:20; display:flex; align-items:center; justify-content:space-between; gap:16px;
      padding:14px clamp(16px,4vw,34px); border-bottom:1px solid rgba(123,92,255,.14);
      backdrop-filter:blur(14px); -webkit-backdrop-filter:blur(14px); background:rgba(6,10,24,.72);
    }
    .brand { display:flex; align-items:center; gap:12px; color:#fff; font-weight:600; }
    .brand img { width:44px; height:44px; border-radius:50%; object-fit:cover; object-position:top; border:2px solid rgba(123,92,255,.55); box-shadow:0 0 22px rgba(123,92,255,.45); }
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
    .admin-card { background: rgba(14, 20, 48, 0.78); border: 1px solid var(--border); border-radius: var(--radius); padding: 24px; backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); box-shadow: var(--shadow-glow); margin-bottom: 24px; }
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
    .actions-stack { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
    .modal-backdrop { position: fixed; inset: 0; z-index: 60; background: rgba(6, 10, 24, .82); backdrop-filter: blur(8px); display: none; align-items: center; justify-content: center; padding: 20px; }
    .modal-backdrop.open { display: flex; }
    .modal-box { width: 100%; max-width: 760px; max-height: 90vh; overflow-y: auto; background: var(--bg-card); border: 1px solid rgba(123, 92, 255, .4); border-radius: var(--radius); padding: 26px; box-shadow: 0 24px 64px rgba(0,0,0,.65); }
    .alert-banner { background: rgba(123, 92, 255, .2); border: 1px solid var(--gold); color: #fff; padding: 14px 18px; border-radius: var(--radius-sm); margin-bottom: 20px; font-size: .9rem; }
    .check-row { display: inline-flex; align-items: center; gap: 8px; font-size: .84rem; color: var(--text-secondary); margin-top: 10px; cursor: pointer; }
    .check-row input { width: auto; }
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
  <main style="position:relative;z-index:1;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;">
    <div class="admin-card" style="width:100%;max-width:620px;padding:32px;">
      <h1 class="display" style="font-size:1.8rem;color:var(--gold);margin-bottom:10px;">${escapeHtml(title)}</h1>
      <pre style="white-space:pre-wrap;background:rgba(6,10,24,.9);border:1px solid var(--border);padding:14px;border-radius:10px;color:#fecaca;font-size:.82rem;margin-bottom:18px;">${escapeHtml(details)}</pre>
      <a href="/" class="btn-primary">Recharger la console</a>
    </div>
  </main>
</body>
</html>`, {
    status: 500,
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

// ============================================================================
// INTERFACES HTML (VISUEL EXACT DU WORKER 2)
// ============================================================================

function renderLoginHTML(error = '') {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  ${renderSharedHead('Connexion • SuperAdmin Pont Digital')}
</head>
<body>
  ${renderBackgroundLayer()}
  <main style="position:relative;z-index:1;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;">
    <div class="admin-card" style="width:100%;max-width:440px;text-align:center;padding:36px 28px;">
      <img src="${NYXIA_AVATAR_URL}" alt="NyXia • Pont Digital" style="width:84px;height:84px;border-radius:50%;margin:0 auto 16px;border:2px solid var(--gold);box-shadow:0 0 30px rgba(244,200,66,.4);object-fit:cover;object-position:top;">
      <span style="font-size:.75rem;letter-spacing:1.5px;text-transform:uppercase;color:var(--gold);font-weight:700;">Agence Pont Digital</span>
      <h1 class="display" style="font-size:2.1rem;margin:6px 0 8px;color:#fff;">Console Super Admin</h1>
      <p style="color:var(--text-secondary);font-size:.9rem;margin-bottom:24px;">Accès réservé à la direction et à l'équipe Appointment Setting.</p>
      ${error ? `<div style="background:rgba(248,113,113,.15);border:1px solid rgba(248,113,113,.4);color:#fecaca;padding:10px 14px;border-radius:10px;font-size:.85rem;margin-bottom:16px;">${escapeHtml(error)}</div>` : ''}
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
  ${renderSharedHead('Associer une fiche Google • Pont Digital')}
</head>
<body>
  ${renderBackgroundLayer()}
  <main style="position:relative;z-index:1;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;">
    <div class="admin-card" style="width:100%;max-width:520px;padding:32px;">
      <h1 class="display" style="font-size:1.9rem;color:var(--gold);margin-bottom:10px;">Sélectionne la fiche Google Business</h1>
      <p style="color:var(--text-secondary);font-size:.92rem;margin-bottom:20px;">
        Ce compte Google gère <strong>${locations.length} établissements</strong>. Choisis celui à associer à <strong>${escapeHtml(client.business_name)}</strong> (${escapeHtml(client.city)}) :
      </p>
      ${locations.length > 0
        ? `<form method="POST" action="/api/google/assign-location">
             <input type="hidden" name="client_id" value="${client.id}">
             <div class="field" style="margin-bottom:20px;">
               <label>Fiche d'établissement Google</label>
               <select name="selected_location" required>${optionsHtml}</select>
             </div>
             <button type="submit" class="btn-primary" style="width:100%;padding:12px;">Associer cette fiche Google au client</button>
           </form>`
        : `<a href="/" class="btn-primary" style="display:inline-block;text-align:center;width:100%;">Retourner au Super Admin</a>`
      }
    </div>
  </main>
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
    rdv_booked: 'Rendez-vous qualifié enregistré ! Clique sur « 📅 Envoyer l’invitation Google Agenda » dans le journal ci-dessous.',
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

  const clientsRows = clients.map(c => {
    const isConnected = Boolean(c.google_refresh_token);
    const hasCal = Boolean(c.booking_calendar_url);
    const webhookClientUrl = `${origin}/webhook/heyzine?client_id=${c.id}`;
    let photosCount = 0;
    try { photosCount = JSON.parse(c.gallery_urls || '[]').length; } catch (_) {}

    return `
      <tr>
        <td>
          <div style="display:flex;align-items:center;gap:10px;">
            ${c.cover_photo_url ? `<img src="${escapeHtml(c.cover_photo_url)}" alt="" style="width:40px;height:40px;border-radius:10px;object-fit:cover;border:1px solid var(--border);flex-shrink:0;">` : ''}
            <div>
              <strong style="color:#fff;font-size:.96rem;">${escapeHtml(c.business_name)}</strong> <span style="color:var(--gold);font-size:.75rem;">#${c.id}</span>
              <div style="font-size:.8rem;color:var(--text-muted);">${escapeHtml(c.category)} • ${escapeHtml(c.city)}</div>
              <div style="font-size:.76rem;color:var(--text-secondary);">${c.rdv_count || 0} RDV • ${c.lead_count || 0} leads • ${c.review_count || 0} avis • ${photosCount} photo(s) galerie</div>
            </div>
          </div>
        </td>
        <td>
          ${hasCal
            ? `<span class="pill pill-ok">● Agenda Google prêt</span>
               <div style="margin-top:6px;"><a href="${escapeHtml(c.booking_calendar_url)}" target="_blank" rel="noopener" class="btn-sm btn-gold">📅 Ouvrir son agenda setter</a></div>`
            : `<span class="pill pill-warn">○ Lien agenda à ajouter</span>`}
          ${c.booking_notes ? `<div style="font-size:.76rem;color:var(--text-muted);margin-top:5px;max-width:240px;">${escapeHtml(c.booking_notes)}</div>` : ''}
          <div style="margin-top:6px;">
            <button type="button" class="btn-sm btn-ghost" onclick="copyWebhook('${escapeHtml(webhookClientUrl)}', this)" title="URL exacte à coller dans le formulaire Heyzine de ce client">📋 Copier Webhook Heyzine #${c.id}</button>
          </div>
        </td>
        <td>
          ${isConnected
            ? `<span class="pill pill-ok">● ${escapeHtml(c.google_location_title || 'GBP Actif')}</span>`
            : `<span class="pill pill-muted">○ Non connecté</span>`}
          <div class="actions-stack" style="margin-top:6px;">
            <a href="/oauth/google/connect?client_id=${c.id}" class="btn-sm btn-ghost">${isConnected ? '↻ Réauth GBP' : '🔗 Connecter Google GBP'}</a>
            ${isConnected ? `<a href="/oauth/google/select-location?client_id=${c.id}" class="btn-sm btn-ghost">Changer fiche</a>` : ''}
          </div>
        </td>
        <td>
          <div class="actions-stack">
            <button type="button" class="btn-sm btn-ghost" onclick='openEditModal(${JSON.stringify(c).replace(/'/g, "&#39;")})'>✏️ Modifier</button>
            ${isConnected ? `
              <form method="POST" action="/api/google/sync-reviews" style="margin:0;">
                <input type="hidden" name="client_id" value="${c.id}">
                <button type="submit" class="btn-sm btn-gold">↻ Sync Avis</button>
              </form>
            ` : ''}
            <form method="POST" action="/api/clients/delete" style="margin:0;" onsubmit="return confirm('Supprimer définitivement ${escapeHtml(c.business_name)} ?');">
              <input type="hidden" name="id" value="${c.id}">
              <button type="submit" class="btn-sm btn-danger">🗑️</button>
            </form>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  const apptRows = recentAppointments.map(a => `
    <tr>
      <td><strong style="color:#fff;">${escapeHtml(a.business_name)}</strong><div style="font-size:.76rem;color:var(--text-muted);">${escapeHtml(a.city)}</div></td>
      <td>${escapeHtml(a.prospect_name)}<div style="font-size:.78rem;color:var(--text-muted);">${escapeHtml(a.prospect_phone || '')} ${a.prospect_email ? '• ' + escapeHtml(a.prospect_email) : ''}</div></td>
      <td><span class="pill pill-ok">📅 ${escapeHtml(a.appointment_datetime.replace('T', ' '))} (${a.duration_minutes} min)</span></td>
      <td style="font-size:.82rem;color:var(--text-secondary);max-width:240px;">${escapeHtml(a.setter_notes || '')}</td>
      <td>
        <div class="actions-stack">
          <a href="${escapeHtml(a.gcal_event_url)}" target="_blank" rel="noopener" class="btn-sm btn-gold">📅 Invitation Google Agenda ↗</a>
          <form method="POST" action="/api/setter/delete" style="margin:0;">
            <input type="hidden" name="id" value="${a.id}">
            <button type="submit" class="btn-sm btn-danger">✕</button>
          </form>
        </div>
      </td>
    </tr>
  `).join('');

  const reviewsRows = recentReviews.map(r => {
    const hasReply = Boolean(r.reply_comment);
    const canReply = Boolean(r.google_refresh_token);
    return `
      <tr>
        <td>
          <strong style="color:#fff;">${escapeHtml(r.business_name)}</strong>
          <div style="font-size:.8rem;color:var(--gold);">${'★'.repeat(r.star_rating || 5)} • ${escapeHtml(r.reviewer_name)}</div>
        </td>
        <td style="max-width:360px;color:var(--text-secondary);">${escapeHtml(r.comment || '(Avis sans texte)')}</td>
        <td style="min-width:260px;">
          ${hasReply
            ? `<div style="font-size:.84rem;color:var(--green);background:rgba(52,211,153,.08);padding:10px;border-radius:10px;border:1px solid rgba(52,211,153,.25);">${escapeHtml(r.reply_comment)}</div>`
            : (canReply
                ? `<form method="POST" action="/api/google/reply-review" style="margin:0;">
                     <input type="hidden" name="review_id" value="${escapeHtml(r.review_id)}">
                     <button type="submit" class="btn-sm btn-gold">✨ Répondre via NyXia &amp; Publier sur Google</button>
                   </form>`
                : `<span class="pill pill-muted">Fiche Google non connectée</span>`)}
        </td>
      </tr>
    `;
  }).join('');

  const leadsRows = recentLeads.map(l => {
    const st = l.handling_status || 'nouveau';
    return `
      <tr>
        <td>
          <strong style="color:#fff;">${escapeHtml(l.prospect_name || 'Prospect')}</strong>
          <div style="font-size:.78rem;color:var(--text-muted);">${escapeHtml(l.prospect_contact || '')}</div>
        </td>
        <td>
          <strong style="color:var(--gold);">${escapeHtml(l.business_name || 'Revue générale')}</strong>
          <div style="font-size:.76rem;color:var(--text-secondary);max-width:300px;">${escapeHtml(l.nyxia_sms_text || l.prospect_message || '')}</div>
        </td>
        <td>
          <form method="POST" action="/api/leads/status" style="margin:0;display:flex;gap:6px;align-items:center;">
            <input type="hidden" name="lead_id" value="${l.id}">
            <select name="handling_status" style="padding:6px 10px;border-radius:8px;background:rgba(6,10,24,.85);border:1px solid var(--border);color:#fff;font-size:.8rem;">
              <option value="nouveau" ${st === 'nouveau' ? 'selected' : ''}>🔴 Nouveau</option>
              <option value="en_cours" ${st === 'en_cours' ? 'selected' : ''}>🟡 En cours</option>
              <option value="rdv_confirme" ${st === 'rdv_confirme' ? 'selected' : ''}>🟢 RDV confirmé</option>
            </select>
            <button type="submit" class="btn-sm btn-ghost">OK</button>
          </form>
        </td>
      </tr>
    `;
  }).join('');

  return `<!DOCTYPE html>
<html lang="fr">
<head>
  ${renderSharedHead('SuperAdmin • Pont Digital')}
</head>
<body>
  ${renderBackgroundLayer()}

  <!-- HEADER PLEINE LARGEUR DU WORKER 2 -->
  <header class="site-header">
    <a href="/" class="brand">
      <img src="${NYXIA_AVATAR_URL}" alt="NyXia • Pont Digital">
      <div class="brand-name">
        <b>PONT DIGITAL • SUPER ADMIN</b>
        <span>Gestion Agence, GBP &amp; Appointment Setting</span>
      </div>
    </a>
    <div class="header-right">
      <a href="#section-sms-test" class="btn-ghost">📱 Tester Alerte SMS Setter</a>
      <a href="/logout" class="btn-primary">Déconnexion</a>
    </div>
  </header>

  <!-- CONTENU EMPILÉ PLEINE LARGEUR DU WORKER 2 -->
  <main class="admin-wrap">
    ${msg && alerts[msg] ? `<div class="alert-banner">${alerts[msg]}</div>` : ''}

    <!-- 1. KPI BAR -->
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

    <!-- 2. AJOUTER UN ENTREPRENEUR (PLEINE LARGEUR) -->
    <section class="admin-card">
      <h2 class="display" style="font-size:1.75rem;color:var(--gold);margin-bottom:14px;">+ Ajouter un entrepreneur au réseau Pont Digital</h2>
      <form method="POST" action="/api/clients">
        <div class="field-grid">
          <div class="field"><label>Nom de l'entreprise *</label><input name="business_name" required placeholder="Ex: Clinique Harmonie"></div>
          <div class="field"><label>Ville / Région *</label><input name="city" required placeholder="Ex: Terrebonne / Longueuil"></div>
          <div class="field"><label>Catégorie d'activité *</label><input name="category" required placeholder="Ex: Massothérapie, Rénovation..."></div>
          <div class="field"><label>Téléphone public</label><input name="phone" placeholder="514-000-0000"></div>
          <div class="field"><label>Courriel vendeur (invitations RDV)</label><input type="email" name="client_email" placeholder="contact@entreprise.ca"></div>
          <div class="field"><label>Lien Prise de RDV Google Workspace (Setter)</label><input type="url" name="booking_calendar_url" placeholder="https://calendar.app.google/..."></div>
          <div class="field"><label>URL Page Heyzine (#page/X)</label><input type="url" name="heyzine_url" placeholder="https://heyzine.com/flip-book/...#page/1"></div>
          <div class="field"><label>URL Vidéo entrevue (YouTube/Vimeo/MP4)</label><input type="url" name="interview_video_url" placeholder="https://..."></div>
          <div class="field"><label>URL Photo couverture principale</label><input type="url" name="cover_photo_url" placeholder="https://..."></div>
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

    <!-- 3. RÉPERTOIRE DES ENTREPRENEURS (PLEINE LARGEUR) -->
    <section class="admin-card">
      <h2 class="display" style="font-size:1.75rem;color:#fff;margin-bottom:14px;">Répertoire des Entrepreneurs, Agendas &amp; Fiches Google</h2>
      <div class="table-scroll">
        <table class="pd-table">
          <thead>
            <tr>
              <th>Entreprise &amp; Médias</th>
              <th>Appointment Setting &amp; Webhook Heyzine</th>
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

    <!-- 4. JOURNAL APPOINTMENT SETTING + INVITATIONS GOOGLE AGENDA (PLEINE LARGEUR) -->
    <section class="admin-card">
      <h2 class="display" style="font-size:1.75rem;color:var(--gold);margin-bottom:14px;">Journal Appointment Setting • Rendez-vous bookés</h2>
      <form method="POST" action="/api/setter/book" style="margin-bottom:20px;padding-bottom:18px;border-bottom:1px solid var(--border);">
        <div class="field-grid">
          <div class="field"><label>Entreprise cliente *</label><select name="client_id" required>${allClientOptions}</select></div>
          <div class="field"><label>Nom du prospect *</label><input name="prospect_name" required placeholder="Prénom Nom"></div>
          <div class="field"><label>Téléphone prospect</label><input name="prospect_phone" placeholder="514-000-0000"></div>
          <div class="field"><label>Courriel prospect</label><input type="email" name="prospect_email" placeholder="prospect@email.com"></div>
          <div class="field"><label>Date et heure du RDV *</label><input type="datetime-local" name="appointment_datetime" required></div>
          <div class="field">
            <label>Durée du RDV</label>
            <select name="duration_minutes">
              <option value="30">30 minutes</option>
              <option value="45">45 minutes</option>
              <option value="60">60 minutes</option>
            </select>
          </div>
          <div class="field"><label>Notes de qualification</label><input name="setter_notes" placeholder="Besoin exprimé par le prospect"></div>
        </div>
        <div style="margin-top:12px;">
          <button type="submit" class="btn-gold btn-sm" style="padding:10px 18px;">📅 Enregistrer le RDV &amp; Préparer l’invitation Google Agenda</button>
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
              <th>Invitation &amp; Action</th>
            </tr>
          </thead>
          <tbody>
            ${apptRows || '<tr><td colspan="5" style="color:var(--text-muted);text-align:center;padding:18px;">Aucun rendez-vous enregistré.</td></tr>'}
          </tbody>
        </table>
      </div>
    </section>

    <!-- 5. STUDIO PUBLICATION GOOGLE BUSINESS PROFILE MULTI-FORMATS + NYXIA (PLEINE LARGEUR) -->
    <section class="admin-card">
      <h2 class="display" style="font-size:1.75rem;color:#fff;margin-bottom:14px;">Publier une actualité, offre ou événement Google Business Profile (avec NyXia)</h2>
      <form method="POST" action="/api/google/create-post">
        <div class="field-grid">
          <div class="field">
            <label>Entreprise cible (${connectedClients.length} connectée(s)) *</label>
            <select id="post-client-select" name="client_id" required>
              <option value="">-- Sélectionner le client GBP --</option>
              ${connectedOptions}
            </select>
          </div>
          <div class="field">
            <label>Format de publication</label>
            <select id="post-topic-type" name="topic_type" onchange="togglePostFields()">
              <option value="STANDARD">📰 Actualité / Reportage Vidéo Heyzine</option>
              <option value="OFFER">🎁 Offre Spéciale / Promotion</option>
              <option value="EVENT">📅 Événement / Portes Ouvertes</option>
            </select>
          </div>
          <div class="field"><label>URL photo (vide = photo client)</label><input id="post-media-url" name="media_url" placeholder="https://..."></div>
          <div class="field" id="action-type-wrap">
            <label>Bouton d'action</label>
            <select name="action_type">
              <option value="LEARN_MORE">En savoir plus (Revue Heyzine)</option>
              <option value="BOOK">Réserver</option>
              <option value="CALL">Appeler</option>
              <option value="SIGN_UP">S'inscrire</option>
            </select>
          </div>
          <div class="field"><label>Lien cible (vide = page Heyzine du client)</label><input id="post-cta-url" name="cta_url" placeholder="https://..."></div>
        </div>

        <div id="event-offer-fields" class="field-grid" style="display:none;margin-top:12px;">
          <div class="field"><label>Titre de l'offre ou de l'événement *</label><input name="event_title" placeholder="Ex: Offre découverte printemps"></div>
          <div class="field"><label>Date de début</label><input type="date" name="start_date"></div>
          <div class="field"><label>Date de fin</label><input type="date" name="end_date"></div>
          <div class="field" id="coupon-field"><label>Code promo (optionnel)</label><input name="coupon_code" placeholder="Ex: PONT20"></div>
        </div>

        <label class="check-row">
          <input type="checkbox" name="use_client_cover" value="1" checked>
          Joindre automatiquement la photo de couverture enregistrée de ce client
        </label>

        <div class="field" style="margin-top:12px;">
          <label>Texte de la publication Google *</label>
          <textarea id="post-summary" name="summary" rows="3" required placeholder="Rédige le post ou clique sur ✨ Rédiger avec NyXia..."></textarea>
        </div>
        <div class="actions-stack" style="margin-top:12px;">
          <button type="button" id="btn-nyxia-draft" class="btn-sm btn-gold" style="padding:10px 16px;" onclick="draftPostWithNyxia()">✨ Rédiger avec NyXia</button>
          <button type="submit" class="btn-primary">Publier sur Google</button>
        </div>
      </form>
    </section>

    <!-- 6. GESTION DES AVIS GOOGLE (PLEINE LARGEUR) -->
    <section class="admin-card">
      <h2 class="display" style="font-size:1.75rem;color:#fff;margin-bottom:14px;">Avis Google Clients &amp; Réponses IA en 1 clic</h2>
      <div class="table-scroll">
        <table class="pd-table">
          <thead>
            <tr>
              <th>Entreprise &amp; Note</th>
              <th>Commentaire</th>
              <th>Réponse publique</th>
            </tr>
          </thead>
          <tbody>
            ${reviewsRows || '<tr><td colspan="3" style="color:var(--text-muted);text-align:center;padding:18px;">Aucun avis synchronisé. Clique sur « ↻ Sync Avis » sur une fiche connectée.</td></tr>'}
          </tbody>
        </table>
      </div>
    </section>

    <!-- 7. DEMANDES ENTRANTES HEYZINE & TEST SMS SETTER (PLEINE LARGEUR) -->
    <section class="admin-card" id="section-sms-test">
      <h2 class="display" style="font-size:1.75rem;color:#fff;margin-bottom:14px;">Demandes entrantes depuis la Revue Heyzine &amp; Test Alerte SMS</h2>
      <form method="POST" action="/api/test-nyxia-sms" style="margin-bottom:20px;padding-bottom:18px;border-bottom:1px solid var(--border);">
        <div class="field-grid">
          <div class="field"><label>Simuler un lead pour le client *</label><select name="client_id" required>${allClientOptions}</select></div>
          <div class="field"><label>Nom du prospect test</label><input name="prospect_name" value="Sophie Gagnon" required></div>
          <div class="field"><label>Contact prospect</label><input name="prospect_contact" value="450-555-0142" required></div>
          <div class="field"><label>Message du prospect</label><input name="prospect_message" value="Intéressée par vos services suite à la revue Heyzine !" required></div>
        </div>
        <div style="margin-top:12px;">
          <button type="submit" class="btn-sm btn-gold" style="padding:10px 18px;">📱 Simuler un lead &amp; envoyer alerte SMS vers ton cellulaire</button>
        </div>
      </form>
      <div class="table-scroll">
        <table class="pd-table">
          <thead>
            <tr>
              <th>Prospect</th>
              <th>Entreprise &amp; Alerte SMS NyXia</th>
              <th>Suivi Setter</th>
            </tr>
          </thead>
          <tbody>
            ${leadsRows || '<tr><td colspan="3" style="color:var(--text-muted);text-align:center;padding:18px;">Aucune demande entrante enregistrée.</td></tr>'}
          </tbody>
        </table>
      </div>
    </section>

    <!-- 8. SÉCURITÉ ÉQUIPE (PLEINE LARGEUR) -->
    <section class="admin-card">
      <h2 class="display" style="font-size:1.5rem;color:var(--gold);margin-bottom:10px;">Sécurité • Mot de passe Associé / Équipe</h2>
      <p style="color:var(--text-secondary);font-size:.88rem;margin-bottom:14px;">Définis un second mot de passe chiffré dans D1 pour ton associé ou tes setters sans partager ton mot de passe maître Cloudflare.</p>
      <form method="POST" action="/api/change-password" style="display:flex;gap:12px;flex-wrap:wrap;max-width:680px;">
        <div class="field" style="flex:1;min-width:200px;">
          <input type="password" name="new_password" placeholder="Nouveau mot de passe (min. 8 car.)" required>
        </div>
        <div class="field" style="flex:1;min-width:200px;">
          <input type="password" name="confirm_password" placeholder="Confirmer le mot de passe" required>
        </div>
        <button type="submit" class="btn-ghost">Enregistrer</button>
      </form>
    </section>
  </main>

  <!-- MODALE ÉDITION CLIENT -->
  <div id="edit-modal" class="modal-backdrop">
    <div class="modal-box">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
        <h3 class="display" style="font-size:1.7rem;color:var(--gold);">Modifier la fiche entrepreneur</h3>
        <button type="button" class="btn-sm btn-ghost" onclick="closeEditModal()">✕ Fermer</button>
      </div>
      <form method="POST" action="/api/clients/update">
        <input type="hidden" name="client_id" id="edit-client_id">
        <div class="field-grid">
          <div class="field"><label>Entreprise *</label><input name="business_name" id="edit-business_name" required></div>
          <div class="field"><label>Ville / Région *</label><input name="city" id="edit-city" required></div>
          <div class="field"><label>Catégorie *</label><input name="category" id="edit-category" required></div>
          <div class="field"><label>Téléphone</label><input name="phone" id="edit-phone"></div>
          <div class="field"><label>Courriel vendeur (invitations RDV)</label><input type="email" name="client_email" id="edit-client_email"></div>
          <div class="field"><label>Lien Agenda Google Workspace</label><input type="url" name="booking_calendar_url" id="edit-booking_calendar_url"></div>
          <div class="field"><label>URL Page Heyzine (#page/X)</label><input type="url" name="heyzine_url" id="edit-heyzine_url"></div>
          <div class="field"><label>URL Vidéo entrevue</label><input type="url" name="interview_video_url" id="edit-interview_video_url"></div>
          <div class="field"><label>URL Photo couverture principale</label><input type="url" name="cover_photo_url" id="edit-cover_photo_url"></div>
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
      var actionWrap = document.getElementById('action-type-wrap');
      box.style.display = (type === 'OFFER' || type === 'EVENT') ? 'grid' : 'none';
      coupon.style.display = (type === 'OFFER') ? 'block' : 'none';
      actionWrap.style.display = (type === 'OFFER') ? 'none' : 'block';
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
