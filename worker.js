const NYXIA_AVATAR_URL = 'https://d1yei2z3i6k35z.cloudfront.net/1872133/6ab6894dc95332.12543838_NyXia.png';

export default {
  async fetch(request, env) {
    // 0. Création / mise à jour automatique des tables D1
    await ensureDatabaseReady(env.DB);

    const url = new URL(request.url);
    const path = url.pathname;

    // 1. Webhook public Heyzine Pro (verrouillé par client_id -> alerte l'agence Pont Digital)
    if (path === '/webhook/heyzine' && request.method === 'POST') {
      return handleHeyzineWebhook(request, env);
    }

    // 2. Connexion & Déconnexion SuperAdmin
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

    // 3. Callback OAuth Google Business Profile (retour de Google)
    if (path === '/oauth/google/callback' && request.method === 'GET') {
      return handleGoogleOAuthCallback(request, env);
    }

    // 4. Vérification de la session active SuperAdmin
    const isAuthenticated = await verifySession(request, env);
    if (!isAuthenticated) {
      return new Response(renderLoginHTML(), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    // 5. Démarrage & Sélection de fiche OAuth Google (Mode Agence Multi-Fiches)
    if (path === '/oauth/google/connect' && request.method === 'GET') {
      return handleGoogleOAuthStart(request, env);
    }

    if (path === '/oauth/google/select-location' && request.method === 'GET') {
      return handleSelectGoogleLocationPage(request, env);
    }

    if (path === '/api/google/assign-location' && request.method === 'POST') {
      return handleAssignGoogleLocationPost(request, env);
    }

    // 6. Actions Google Business Profile (Sync Avis, Studio Multi-Posts & Réponse NyXia)
    if (path === '/api/google/sync-reviews' && request.method === 'POST') {
      return handleSyncReviewsRoute(request, env);
    }

    if (path === '/api/google/create-post' && request.method === 'POST') {
      return handleCreateGooglePostRoute(request, env);
    }

    if (path === '/api/google/reply-review' && request.method === 'POST') {
      return handleReplyReviewWithNyxiaRoute(request, env);
    }

    // 7. Générateur IA NyXia pour rédiger un post client à la demande
    if (path === '/api/nyxia/draft-post' && request.method === 'POST') {
      return handleNyxiaDraftPostApi(request, env);
    }

    // 8. Module Appointment Setter (Création de RDV qualifiés + Agenda Google Workspace)
    if (path === '/api/setter/book' && request.method === 'POST') {
      return handleBookAppointmentRoute(request, env);
    }

    // 9. Test manuel & suivi Done-For-You des leads
    if (path === '/api/test-nyxia-sms' && request.method === 'POST') {
      return handleTestNyxiaSmsRoute(request, env);
    }

    if (path === '/api/leads/status' && request.method === 'POST') {
      return handleUpdateLeadStatus(request, env);
    }

    // 10. Gestion des entrepreneurs, agendas & médias dédiés par client
    if (path === '/api/change-password' && request.method === 'POST') {
      return handleChangePassword(request, env);
    }

    if (path === '/api/clients' && request.method === 'POST') {
      return handleAddClient(request, env);
    }

    if (path === '/api/clients/media' && request.method === 'POST') {
      return handleUpdateClientMedia(request, env);
    }

    if (path === '/api/clients/delete' && request.method === 'POST') {
      return handleDeleteClient(request, env);
    }

    // 11. Chargement des données et affichage du Tableau de Bord
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
      LIMIT 8
    `).all();

    const { results: recentLeads } = await env.DB.prepare(`
      SELECT l.*, c.business_name
      FROM heyzine_leads l
      LEFT JOIN clients c ON c.id = l.client_id
      ORDER BY l.created_at DESC
      LIMIT 10
    `).all();

    const { results: recentAppointments } = await env.DB.prepare(`
      SELECT a.*, c.business_name, c.city, c.client_email, c.booking_calendar_url
      FROM appointments a
      JOIN clients c ON c.id = a.client_id
      ORDER BY a.created_at DESC
      LIMIT 8
    `).all();

    return new Response(
      renderDashboardHTML(clients, recentReviews, recentLeads, recentAppointments, url.searchParams.get('msg'), url.origin),
      { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  },

  // Tâche planifiée nocturne : synchronisation silencieuse des avis Google de tous les clients
  async scheduled(event, env, ctx) {
    ctx.waitUntil(syncAllConnectedClientsReviews(env));
  }
};

// ============================================================================
// INITIALISATION & MIGRATION AUTOMATIQUE DE LA BASE D1
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
        heyzine_url TEXT,
        interview_video_url TEXT,
        cover_photo_url TEXT,
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
    'ALTER TABLE clients ADD COLUMN client_email TEXT',
    'ALTER TABLE clients ADD COLUMN booking_calendar_url TEXT',
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

  // Si un lead récent porte ce nom pour ce client, on le passe automatiquement en statut "rdv_confirme"
  await env.DB.prepare(`
    UPDATE heyzine_leads
    SET handling_status = 'rdv_confirme'
    WHERE client_id = ? AND prospect_name LIKE ? AND handling_status != 'rdv_confirme'
  `).bind(client.id, `%${prospectName}%`).run();

  return Response.redirect(new URL('/?msg=rdv_booked', request.url), 302);
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
// RÉPONSE AUTOMATIQUE AUX AVIS GOOGLE PAR NYXIA (OPENROUTER / GEMINI)
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
// AUTHENTIFICATION & GESTION DES ENTREPRENEURS / AGENDAS / MÉDIAS PAR CLIENT
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
  const heyzineUrl = (formData.get('heyzine_url') || '').trim();
  const interviewVideoUrl = (formData.get('interview_video_url') || '').trim();
  const coverPhotoUrl = (formData.get('cover_photo_url') || '').trim();

  if (!businessName || !city || !category) {
    return Response.redirect(new URL('/?msg=error_fields', request.url), 302);
  }

  await env.DB.prepare(`
    INSERT INTO clients (business_name, city, category, phone, client_email, booking_calendar_url, heyzine_url, interview_video_url, cover_photo_url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(businessName, city, category, phone, clientEmail, bookingCalendarUrl, heyzineUrl, interviewVideoUrl, coverPhotoUrl).run();

  return Response.redirect(new URL('/?msg=client_added', request.url), 302);
}

async function handleUpdateClientMedia(request, env) {
  const formData = await request.formData();
  const clientId = formData.get('client_id');
  const clientEmail = (formData.get('client_email') || '').trim();
  const bookingCalendarUrl = (formData.get('booking_calendar_url') || '').trim();
  const heyzineUrl = (formData.get('heyzine_url') || '').trim();
  const interviewVideoUrl = (formData.get('interview_video_url') || '').trim();
  const coverPhotoUrl = (formData.get('cover_photo_url') || '').trim();

  if (!clientId) {
    return Response.redirect(new URL('/?msg=error_fields', request.url), 302);
  }

  await env.DB.prepare(`
    UPDATE clients
    SET client_email = ?,
        booking_calendar_url = ?,
        heyzine_url = ?,
        interview_video_url = ?,
        cover_photo_url = ?
    WHERE id = ?
  `).bind(clientEmail, bookingCalendarUrl, heyzineUrl, interviewVideoUrl, coverPhotoUrl, clientId).run();

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

// ============================================================================
// SCRIPT CIEL ÉTOILÉ (starry-bg.js)
// ============================================================================

const STARRY_SCRIPT = `
<script>
;(function () {
  'use strict'
  var canvas = document.getElementById('starry-canvas')
  if (!canvas) return
  var ctx = canvas.getContext('2d')
  var stars = []
  var shootingStars = []
  var STAR_COUNT = 400
  var SHOOTING_INTERVAL = 3000

  function resize() {
    canvas.width = window.innerWidth
    canvas.height = window.innerHeight
  }
  function createStars() {
    stars = []
    for (var i = 0; i < STAR_COUNT; i++) {
      stars.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        radius: Math.random() * 1.5 + 0.3,
        opacity: Math.random() * 0.8 + 0.2,
        twinkleSpeed: Math.random() * 0.02 + 0.005,
        phase: Math.random() * Math.PI * 2
      })
    }
  }
  function createShootingStar() {
    shootingStars.push({
      x: Math.random() * canvas.width * 0.7,
      y: Math.random() * canvas.height * 0.3,
      length: Math.random() * 80 + 40,
      speed: Math.random() * 8 + 4,
      angle: Math.PI / 4 + (Math.random() - 0.5) * 0.3,
      opacity: 1,
      life: 1
    })
  }
  function drawStars(time) {
    for (var i = 0; i < stars.length; i++) {
      var s = stars[i]
      var flicker = Math.sin(time * s.twinkleSpeed + s.phase) * 0.3 + 0.7
      ctx.beginPath()
      ctx.arc(s.x, s.y, s.radius, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(255,255,255,' + (s.opacity * flicker).toFixed(3) + ')'
      ctx.fill()
    }
  }
  function drawShootingStars() {
    for (var i = shootingStars.length - 1; i >= 0; i--) {
      var ss = shootingStars[i]
      var tailX = ss.x - Math.cos(ss.angle) * ss.length
      var tailY = ss.y - Math.sin(ss.angle) * ss.length
      var grad = ctx.createLinearGradient(tailX, tailY, ss.x, ss.y)
      grad.addColorStop(0, 'rgba(255,255,255,0)')
      grad.addColorStop(1, 'rgba(255,255,255,' + (ss.opacity * ss.life).toFixed(3) + ')')
      ctx.beginPath()
      ctx.moveTo(tailX, tailY)
      ctx.lineTo(ss.x, ss.y)
      ctx.strokeStyle = grad
      ctx.lineWidth = 1.5
      ctx.stroke()
      ss.x += Math.cos(ss.angle) * ss.speed
      ss.y += Math.sin(ss.angle) * ss.speed
      ss.life -= 0.015
      if (ss.life <= 0) shootingStars.splice(i, 1)
    }
  }
  function animate(time) {
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    drawStars(time)
    drawShootingStars()
    requestAnimationFrame(animate)
  }
  resize()
  createStars()
  requestAnimationFrame(animate)
  setInterval(createShootingStar, SHOOTING_INTERVAL)
  window.addEventListener('resize', function () {
    resize()
    createStars()
  })
})()
</script>
`;

// ============================================================================
// INTERFACES HTML COMPLÈTES (UNIVERS NYXIA : BLEU NUIT, VIOLET & OR CHAMPAGNE)
// ============================================================================

function renderLoginHTML(error = '') {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SuperAdmin — Pont Digital • Univers NyXia</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@600;700&family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    body { margin:0; font-family:'Outfit',system-ui,sans-serif; background:#060A18; color:#F8FAFC; display:flex; align-items:center; justify-content:center; min-height:100vh; overflow:hidden; }
    #starry-canvas { position:fixed; inset:0; width:100%; height:100%; z-index:0; pointer-events:none; }
    .card { position:relative; z-index:1; background:rgba(11,21,48,0.82); backdrop-filter:blur(14px); -webkit-backdrop-filter:blur(14px); border:1px solid rgba(123,92,255,0.4); padding:2.5rem 2.2rem; border-radius:20px; width:100%; max-width:390px; box-shadow:0 24px 60px rgba(0,0,0,0.7), 0 0 40px rgba(123,92,255,0.18); text-align:center; }
    .avatar-ring { width:84px; height:84px; margin:0 auto 1rem; border-radius:50%; padding:2px; background:linear-gradient(135deg,#7B5CFF,#C9A24A); box-shadow:0 0 24px rgba(123,92,255,0.55); }
    .avatar-ring img { width:100%; height:100%; object-fit:cover; object-position:top; border-radius:50%; display:block; background:#060A18; }
    h1 { font-family:'Cormorant Garamond',Georgia,serif; margin:0 0 0.35rem; font-size:1.85rem; color:#E9CC80; letter-spacing:0.04em; }
    p { color:#94A3B8; font-size:0.9rem; margin:0 0 1.5rem; }
    input { width:100%; box-sizing:border-box; padding:0.85rem 1rem; border-radius:10px; border:1px solid rgba(123,92,255,0.35); background:rgba(6,10,24,0.85); color:#fff; margin-bottom:1rem; font-size:0.95rem; font-family:inherit; }
    input:focus { outline:none; border-color:#E9CC80; }
    button { width:100%; padding:0.9rem; border:none; border-radius:10px; background:linear-gradient(135deg, #7B5CFF, #5B3FD9); color:#fff; font-weight:600; font-size:0.98rem; cursor:pointer; font-family:inherit; box-shadow:0 8px 20px rgba(123,92,255,0.3); }
    button:hover { opacity:0.94; }
    .err { background:rgba(239,68,68,0.15); border:1px solid #EF4444; color:#FCA5A5; padding:0.75rem; border-radius:10px; margin-bottom:1rem; font-size:0.85rem; }
  </style>
</head>
<body>
  <canvas id="starry-canvas"></canvas>
  <div class="card">
    <div class="avatar-ring">
      <img src="${NYXIA_AVATAR_URL}" alt="NyXia">
    </div>
    <h1>PONT DIGITAL • Admin</h1>
    <p>Poste de commandement réservé à l'équipe.</p>
    ${error ? `<div class="err">${escapeHtml(error)}</div>` : ''}
    <form method="POST" action="/login">
      <input type="password" name="password" placeholder="Mot de passe d'accès" required autofocus />
      <button type="submit">Déverrouiller la console</button>
    </form>
  </div>
  ${STARRY_SCRIPT}
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
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sélectionner la fiche Google — Pont Digital</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@600;700&family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    body { margin:0; font-family:'Outfit',system-ui,sans-serif; background:#060A18; color:#F8FAFC; display:flex; align-items:center; justify-content:center; min-height:100vh; padding:1rem; }
    #starry-canvas { position:fixed; inset:0; width:100%; height:100%; z-index:0; pointer-events:none; }
    .card { position:relative; z-index:1; background:rgba(11,21,48,0.85); backdrop-filter:blur(14px); border:1px solid rgba(201,162,74,0.4); padding:2.2rem; border-radius:20px; width:100%; max-width:520px; box-shadow:0 24px 60px rgba(0,0,0,0.7); }
    h1 { font-family:'Cormorant Garamond',Georgia,serif; margin:0 0 0.5rem; font-size:1.75rem; color:#E9CC80; }
    p { color:#94A3B8; font-size:0.92rem; line-height:1.5; margin-bottom:1.5rem; }
    select { width:100%; box-sizing:border-box; padding:0.85rem; border-radius:10px; border:1px solid rgba(123,92,255,0.45); background:#060A18; color:#fff; margin-bottom:1.25rem; font-size:0.95rem; font-family:inherit; }
    button { width:100%; padding:0.9rem; border:none; border-radius:10px; background:linear-gradient(135deg, #7B5CFF, #5B3FD9); color:#fff; font-weight:600; font-size:0.98rem; cursor:pointer; font-family:inherit; }
    .back-link { display:block; text-align:center; margin-top:1rem; color:#94A3B8; font-size:0.85rem; text-decoration:none; }
  </style>
</head>
<body>
  <canvas id="starry-canvas"></canvas>
  <div class="card">
    <h1>Compte Agence Google Détecté</h1>
    <p>
      Ce compte Google gère <strong>${locations.length} établissements</strong>.<br>
      Choisis exactement quelle fiche Google Business Profile associer à <strong>${escapeHtml(client.business_name)}</strong> (${escapeHtml(client.city)}) :
    </p>
    ${locations.length > 0
      ? `<form method="POST" action="/api/google/assign-location">
           <input type="hidden" name="client_id" value="${client.id}" />
           <select name="selected_location" required>
             ${optionsHtml}
           </select>
           <button type="submit">Associer cette fiche Google au client</button>
         </form>`
      : `<p style="color:#FCA5A5;">Aucune fiche Google Business Profile trouvée sur ce compte Google.</p>`
    }
    <a href="/" class="back-link">← Retour au tableau de bord</a>
  </div>
  ${STARRY_SCRIPT}
</body>
</html>`;
}

function renderDashboardHTML(clients, recentReviews, recentLeads, recentAppointments, msg, origin) {
  const alerts = {
    pwd_updated: 'Mot de passe interne mis à jour avec succès dans D1.',
    error_pwd: 'Erreur : le mot de passe doit contenir au moins 8 caractères et être identique.',
    client_added: 'Entrepreneur ajouté à la base D1 Pont Digital avec son agenda et son dossier média.',
    media_updated: 'Configuration Agenda Workspace & Médias de l’entrepreneur mise à jour !',
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
    rdv_booked: 'Rendez-vous qualifié enregistré ! Clique sur « 📅 Envoyer l’invitation Google Agenda » ci-dessous pour notifier instantanément le client et le prospect.'
  };

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
    return `
    <tr>
      <td>
        <strong style="color:#fff;">${escapeHtml(c.business_name)}</strong> <span style="color:#E9CC80; font-size:0.75rem;">#${c.id}</span><br>
        <span style="font-size:0.75rem; color:#94A3B8;">${escapeHtml(c.city)} • ${escapeHtml(c.category)}</span><br>
        <span style="font-size:0.72rem; color:#64748B;">${c.rdv_count || 0} RDV • ${c.lead_count || 0} leads • ${c.review_count || 0} avis</span><br>
        ${c.booking_calendar_url
          ? `<a href="${escapeHtml(c.booking_calendar_url)}" target="_blank" rel="noopener" class="cal-badge">📅 Voir disponibilités Workspace ↗</a>`
          : `<span style="font-size:0.72rem; color:#64748B;">Lien agenda Workspace à ajouter →</span>`
        }
      </td>
      <td style="min-width:270px;">
        <form method="POST" action="/api/clients/media" style="margin:0; display:grid; gap:0.35rem;">
          <input type="hidden" name="client_id" value="${c.id}" />
          <input type="email" name="client_email" value="${escapeHtml(c.client_email || '')}" placeholder="Courriel client / vendeur (invitations RDV)" style="margin:0; padding:0.38rem 0.6rem; font-size:0.78rem;" />
          <input type="url" name="booking_calendar_url" value="${escapeHtml(c.booking_calendar_url || '')}" placeholder="Lien Page Réservation Google Workspace" style="margin:0; padding:0.38rem 0.6rem; font-size:0.78rem;" />
          <input type="url" name="heyzine_url" value="${escapeHtml(c.heyzine_url || '')}" placeholder="URL Page Heyzine (#page/X)" style="margin:0; padding:0.38rem 0.6rem; font-size:0.78rem;" />
          <input type="url" name="interview_video_url" value="${escapeHtml(c.interview_video_url || '')}" placeholder="URL Vidéo entrevue (YouTube/Vimeo/MP4)" style="margin:0; padding:0.38rem 0.6rem; font-size:0.78rem;" />
          <input type="url" name="cover_photo_url" value="${escapeHtml(c.cover_photo_url || '')}" placeholder="URL Photo couverture client" style="margin:0; padding:0.38rem 0.6rem; font-size:0.78rem;" />
          <div style="display:flex; gap:0.4rem; align-items:center;">
            <button type="submit" class="sync-btn" style="flex:1;">💾 Enregistrer fiche</button>
            <button type="button" class="copy-wh-btn" onclick="copyWebhook('${escapeHtml(webhookClientUrl)}', this)" title="URL exacte à coller dans le formulaire Heyzine de ce client">📋 Webhook #${c.id}</button>
          </div>
        </form>
      </td>
      <td>
        ${isConnected
          ? `<div style="display:flex; gap:0.4rem; align-items:center; flex-wrap:wrap;">
               <span class="badge connected">● ${escapeHtml(c.google_location_title || 'GBP Actif')}</span>
               <form method="POST" action="/api/google/sync-reviews" style="margin:0;">
                 <input type="hidden" name="client_id" value="${c.id}" />
                 <button type="submit" class="sync-btn">↻ Sync Avis</button>
               </form>
               <a href="/oauth/google/select-location?client_id=${c.id}" class="oauth-link">Changer fiche</a>
               <a href="/oauth/google/connect?client_id=${c.id}" class="oauth-link">Réauth</a>
             </div>`
          : `<a href="/oauth/google/connect?client_id=${c.id}" class="oauth-btn">Connecter Google GBP</a>`
        }
      </td>
      <td>
        <form method="POST" action="/api/clients/delete" style="margin:0;" onsubmit="return confirm('Supprimer cette fiche ?');">
          <input type="hidden" name="id" value="${c.id}" />
          <button type="submit" class="del-btn">Supprimer</button>
        </form>
      </td>
    </tr>
  `;
  }).join('');

  const appointmentCards = recentAppointments.map(a => `
    <div style="background:rgba(6,10,24,0.78); border:1px solid rgba(201,162,74,0.32); border-radius:10px; padding:0.9rem; margin-bottom:0.75rem;">
      <div style="display:flex; justify-content:space-between; font-size:0.82rem; margin-bottom:0.35rem; gap:0.5rem; flex-wrap:wrap;">
        <strong style="color:#E9CC80;">${escapeHtml(a.business_name)} (${escapeHtml(a.city)})</strong>
        <span style="color:#34D399;">📅 ${escapeHtml(a.appointment_datetime.replace('T', ' '))} (${a.duration_minutes} min)</span>
      </div>
      <div style="font-size:0.82rem; color:#F8FAFC; margin-bottom:0.35rem;">
        Prospect qualifié : <strong>${escapeHtml(a.prospect_name)}</strong>
        ${a.prospect_phone ? `• 📞 ${escapeHtml(a.prospect_phone)}` : ''}
        ${a.prospect_email ? `• ✉️ ${escapeHtml(a.prospect_email)}` : ''}
      </div>
      ${a.setter_notes ? `<div style="font-size:0.78rem; color:#94A3B8; margin-bottom:0.55rem;">Notes : ${escapeHtml(a.setter_notes)}</div>` : ''}
      <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">
        <a href="${escapeHtml(a.gcal_event_url)}" target="_blank" rel="noopener" class="gcal-btn">📅 Envoyer l’invitation Google Agenda ↗</a>
        ${a.booking_calendar_url ? `<a href="${escapeHtml(a.booking_calendar_url)}" target="_blank" rel="noopener" class="oauth-link" style="align-self:center;">Ouvrir page réservation client</a>` : ''}
      </div>
    </div>
  `).join('');

  const leadCards = recentLeads.map(l => {
    const smsBadge = l.sms_status === 'sent'
      ? '<span style="color:#34D399;">✓ SMS reçu par l’agence</span>'
      : `<span style="color:#E9CC80;">${escapeHtml(l.sms_status)}</span>`;
    const st = l.handling_status || 'nouveau';
    return `
      <div style="background:rgba(6,10,24,0.78); border:1px solid rgba(123,92,255,0.22); border-radius:10px; padding:0.9rem; margin-bottom:0.75rem;">
        <div style="display:flex; justify-content:space-between; font-size:0.8rem; margin-bottom:0.35rem; gap:0.5rem; flex-wrap:wrap;">
          <strong style="color:#E9CC80;">Client : ${escapeHtml(l.business_name || 'Non associé')}</strong>
          ${smsBadge}
        </div>
        <div style="font-size:0.82rem; color:#94A3B8; margin-bottom:0.4rem;">
          Prospect à appeler : <strong style="color:#fff;">${escapeHtml(l.prospect_name)}</strong> (${escapeHtml(l.prospect_contact)})
        </div>
        <div style="font-size:0.8rem; color:#C4B5FD; background:rgba(11,21,48,0.9); padding:0.55rem; border-radius:8px; border-left:2px solid #7B5CFF; margin-bottom:0.55rem;">
          <strong>Alerte SMS NyXia :</strong> ${escapeHtml(l.nyxia_sms_text || '')}
        </div>
        <form method="POST" action="/api/leads/status" style="margin:0; display:flex; gap:0.4rem; align-items:center;">
          <input type="hidden" name="lead_id" value="${l.id}" />
          <select name="handling_status" style="margin:0; padding:0.35rem 0.5rem; font-size:0.78rem; flex:1;">
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
    <div style="background:rgba(6,10,24,0.78); border:1px solid rgba(201,162,74,0.22); border-radius:10px; padding:0.9rem; margin-bottom:0.75rem;">
      <div style="display:flex; justify-content:space-between; font-size:0.8rem; margin-bottom:0.35rem;">
        <strong style="color:#E9CC80;">${escapeHtml(r.business_name)}</strong>
        <span style="color:#FBBF24;">${'★'.repeat(r.star_rating || 5)}</span>
      </div>
      <div style="font-size:0.8rem; color:#94A3B8; margin-bottom:0.3rem;">Par ${escapeHtml(r.reviewer_name)}</div>
      <div style="font-size:0.85rem; color:#E2E8F0; margin-bottom:0.6rem;">${escapeHtml(r.comment || '(Note sans commentaire)')}</div>
      ${hasReply
        ? `<div style="font-size:0.8rem; color:#34D399; background:rgba(11,21,48,0.9); padding:0.55rem; border-radius:8px; border-left:2px solid #10B981;">
             <strong>✓ Réponse publiée :</strong> ${escapeHtml(r.reply_comment)}
           </div>`
        : (canReply
            ? `<form method="POST" action="/api/google/reply-review" style="margin:0;">
                 <input type="hidden" name="review_id" value="${escapeHtml(r.review_id)}" />
                 <button type="submit" class="nyxia-reply-btn">✨ Répondre via NyXia &amp; Publier sur Google</button>
               </form>`
            : `<span style="font-size:0.75rem; color:#64748B;">Fiche Google non connectée pour répondre</span>`)
      }
    </div>
  `;
  }).join('');

  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SuperAdmin • Pont Digital • NyXia</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@600;700&family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    body { margin:0; font-family:'Outfit',system-ui,sans-serif; background:#060A18; color:#F8FAFC; min-height:100vh; }
    #starry-canvas { position:fixed; inset:0; width:100%; height:100%; z-index:0; pointer-events:none; }
    .app-layer { position:relative; z-index:1; }
    header { background:rgba(11,21,48,0.85); backdrop-filter:blur(12px); border-bottom:1px solid rgba(201,162,74,0.25); padding:0.9rem 2rem; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:1rem; }
    .brand-group { display:flex; align-items:center; gap:0.85rem; }
    .nyxia-mini { width:42px; height:42px; border-radius:50%; padding:1.5px; background:linear-gradient(135deg,#7B5CFF,#C9A24A); box-shadow:0 0 15px rgba(123,92,255,0.45); }
    .nyxia-mini img { width:100%; height:100%; object-fit:cover; object-position:top; border-radius:50%; display:block; background:#060A18; }
    header h1 { font-family:'Cormorant Garamond',Georgia,serif; margin:0; font-size:1.55rem; color:#E9CC80; letter-spacing:0.04em; }
    .webhook-pill { background:rgba(6,10,24,0.85); border:1px solid rgba(123,92,255,0.35); padding:0.35rem 0.8rem; border-radius:8px; font-size:0.78rem; color:#C4B5FD; }
    .logout { color:#94A3B8; text-decoration:none; font-size:0.88rem; border:1px solid rgba(201,162,74,0.35); padding:0.4rem 0.95rem; border-radius:8px; }
    .logout:hover { color:#E9CC80; border-color:#E9CC80; }
    .container { max-width:1360px; margin:2rem auto; padding:0 1.5rem; display:grid; gap:1.5rem; }
    .grid-3 { display:grid; grid-template-columns: 1fr 1.1fr 1fr; gap:1.5rem; }
    .grid-2 { display:grid; grid-template-columns: 1fr 1fr; gap:1.5rem; }
    @media(max-width:1080px){ .grid-3, .grid-2 { grid-template-columns:1fr; } }
    .panel { background:rgba(11,21,48,0.8); backdrop-filter:blur(12px); -webkit-backdrop-filter:blur(12px); border:1px solid rgba(123,92,255,0.25); border-radius:16px; padding:1.5rem; overflow-x:auto; box-shadow:0 16px 40px rgba(0,0,0,0.45); }
    h2 { font-family:'Cormorant Garamond',Georgia,serif; margin-top:0; font-size:1.35rem; color:#E9CC80; letter-spacing:0.02em; }
    input, select, textarea { width:100%; box-sizing:border-box; padding:0.65rem 0.85rem; border-radius:8px; border:1px solid rgba(123,92,255,0.3); background:rgba(6,10,24,0.85); color:#fff; margin-bottom:0.7rem; font-family:inherit; font-size:0.86rem; }
    input:focus, select:focus, textarea:focus { outline:none; border-color:#E9CC80; }
    button { padding:0.72rem 1.15rem; border:none; border-radius:8px; background:linear-gradient(135deg,#7B5CFF,#5B3FD9); color:#fff; font-weight:600; cursor:pointer; font-family:inherit; }
    button:hover { opacity:0.93; }
    button.gold { background:linear-gradient(135deg,#E9CC80,#C9A24A); color:#060A18; }
    button.draft-btn { background:rgba(201,162,74,0.16); border:1px solid rgba(201,162,74,0.5); color:#E9CC80; width:100%; margin-bottom:0.7rem; font-size:0.84rem; }
    button.draft-btn:hover { background:#C9A24A; color:#060A18; }
    button.sync-btn { background:rgba(16,185,129,0.14); border:1px solid rgba(16,185,129,0.45); color:#34D399; padding:0.35rem 0.65rem; font-size:0.75rem; }
    button.sync-btn:hover { background:#10B981; color:#060A18; }
    button.copy-wh-btn { background:rgba(123,92,255,0.16); border:1px solid rgba(123,92,255,0.45); color:#C4B5FD; padding:0.35rem 0.65rem; font-size:0.75rem; }
    button.nyxia-reply-btn { background:linear-gradient(135deg, #7B5CFF, #5B3FD9); color:#fff; padding:0.5rem 0.85rem; font-size:0.78rem; width:100%; }
    button.del-btn { background:transparent; border:1px solid rgba(239,68,68,0.45); color:#FCA5A5; padding:0.35rem 0.65rem; font-size:0.75rem; }
    table { width:100%; border-collapse:collapse; font-size:0.86rem; }
    th, td { text-align:left; padding:0.75rem; border-bottom:1px solid rgba(123,92,255,0.15); vertical-align:top; }
    th { color:#E9CC80; font-weight:500; }
    .badge { background:#1E293B; padding:0.25rem 0.65rem; border-radius:99px; font-size:0.75rem; color:#E9CC80; display:inline-block; }
    .badge.connected { background:rgba(16,185,129,0.14); border:1px solid rgba(16,185,129,0.4); color:#34D399; }
    .cal-badge { display:inline-block; margin-top:0.35rem; background:rgba(201,162,74,0.14); border:1px solid rgba(201,162,74,0.45); color:#E9CC80; text-decoration:none; padding:0.25rem 0.6rem; border-radius:6px; font-size:0.75rem; }
    .cal-badge:hover { background:#C9A24A; color:#060A18; }
    .gcal-btn { display:inline-block; background:linear-gradient(135deg,#E9CC80,#C9A24A); color:#060A18; text-decoration:none; padding:0.42rem 0.8rem; border-radius:8px; font-size:0.78rem; font-weight:700; }
    .oauth-btn { display:inline-block; background:rgba(123,92,255,0.16); border:1px solid #7B5CFF; color:#C4B5FD; text-decoration:none; padding:0.38rem 0.75rem; border-radius:8px; font-size:0.8rem; font-weight:500; }
    .oauth-btn:hover { background:#7B5CFF; color:#fff; }
    .oauth-link { color:#94A3B8; font-size:0.75rem; text-decoration:underline; }
    .alert { background:rgba(123,92,255,0.2); border:1px solid #7B5CFF; padding:0.85rem 1.2rem; border-radius:10px; color:#F8FAFC; }
    .check-row { display:flex; align-items:center; gap:0.5rem; font-size:0.82rem; color:#C4B5FD; margin-bottom:0.75rem; }
    .check-row input { width:auto; margin:0; }
  </style>
</head>
<body>
  <canvas id="starry-canvas"></canvas>
  <div class="app-layer">
    <header>
      <div class="brand-group">
        <div class="nyxia-mini">
          <img src="${NYXIA_AVATAR_URL}" alt="NyXia">
        </div>
        <h1>PONT DIGITAL • SuperAdmin Setter &amp; Agence</h1>
      </div>
      <div class="webhook-pill">Agence Setter • Agendas Google Workspace &amp; Alertes SMS</div>
      <a href="/logout" class="logout">Déconnexion</a>
    </header>

    <div class="container">
      ${msg && alerts[msg] ? `<div class="alert">${alerts[msg]}</div>` : ''}

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
            <input type="url" name="heyzine_url" placeholder="URL Page Heyzine du client (#page/X)" />
            <input type="url" name="interview_video_url" placeholder="URL Vidéo entrevue (YouTube/Vimeo/MP4)" />
            <input type="url" name="cover_photo_url" placeholder="URL Photo couverture du client" />
            <button type="submit" style="width:100%;">Créer la fiche verrouillée D1</button>
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
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:0.5rem;">
              <input type="text" name="prospect_phone" placeholder="Téléphone prospect" />
              <input type="email" name="prospect_email" placeholder="Courriel prospect" />
            </div>
            <div style="display:grid; grid-template-columns:1.4fr 0.6fr; gap:0.5rem;">
              <input type="datetime-local" name="appointment_datetime" required title="Date et heure du rendez-vous" />
              <select name="duration_minutes" title="Durée du RDV">
                <option value="30">30 min</option>
                <option value="45">45 min</option>
                <option value="60">60 min</option>
              </select>
            </div>
            <textarea name="setter_notes" rows="3" placeholder="Notes de qualification pour le vendeur (besoin, budget, adresse du chantier/propriété)..."></textarea>
            <button type="submit" class="gold" style="width:100%;">📅 Enregistrer le RDV &amp; Préparer l’invitation</button>
          </form>

          <hr style="border:0; border-top:1px solid rgba(123,92,255,0.2); margin:1.25rem 0;">

          <h2>Tester Alerte SMS Setter</h2>
          <form method="POST" action="/api/test-nyxia-sms" style="margin:0;">
            <select name="client_id" required>
              <option value="">-- Prospect intéressé par quel client ? --</option>
              ${allClientOptions}
            </select>
            <input type="text" name="prospect_name" placeholder="Nom du prospect test" value="Sophie Gagnon" required />
            <input type="text" name="prospect_contact" placeholder="Tél ou courriel du prospect" value="450-555-0142" required />
            <input type="text" name="prospect_message" placeholder="Message du prospect" value="Intéressée par vos services suite à l'article Heyzine !" required />
            <button type="submit" style="width:100%;">Simuler un lead vers ton cellulaire</button>
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
              <div style="display:grid; grid-template-columns:1fr 1fr; gap:0.5rem;">
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
            <button type="submit" style="width:100%;">Publier sur la fiche Google du client</button>
          </form>
        </div>
      </div>

      <div class="panel">
        <h2>Entrepreneurs actifs, Agendas Workspace &amp; Médias Verrouillés (${clients.length})</h2>
        <table>
          <thead>
            <tr>
              <th>Entreprise &amp; Agenda</th>
              <th>Courriel Vendeur, Agenda Workspace &amp; Médias Dédiés</th>
              <th>Google Business Profile</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            ${rows || '<tr><td colspan="4" style="color:#94A3B8;">Aucun entrepreneur enregistré.</td></tr>'}
          </tbody>
        </table>
      </div>

      <div class="grid-2">
        <div class="panel">
          <h2>📅 Rendez-vous qualifiés livrés aux clients (${recentAppointments.length})</h2>
          ${appointmentCards || '<p style="color:#94A3B8; font-size:0.9rem;">Utilise le module Setter ci-dessus pour booker un premier rendez-vous qualifié.</p>'}
        </div>

        <div class="panel">
          <h2>Leads entrants à qualifier par les Setters (${recentLeads.length})</h2>
          ${leadCards || '<p style="color:#94A3B8; font-size:0.9rem;">Aucun prospect reçu depuis Heyzine Pro pour le moment.</p>'}
        </div>
      </div>

      <div class="grid-2">
        <div class="panel">
          <h2>Derniers avis Google synchronisés (${recentReviews.length})</h2>
          ${reviewCards || '<p style="color:#94A3B8; font-size:0.9rem;">Clique sur « ↻ Sync Avis » sur un client connecté.</p>'}
        </div>

        <div class="panel">
          <h2>Sécurité • Mot de passe équipe</h2>
          <form method="POST" action="/api/change-password">
            <input type="password" name="new_password" placeholder="Nouveau mot de passe (min. 8 car.)" required />
            <input type="password" name="confirm_password" placeholder="Confirmer le mot de passe" required />
            <button type="submit" class="gold">Mettre à jour le mot de passe</button>
          </form>
        </div>
      </div>
    </div>
  </div>

  <script>
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
  ${STARRY_SCRIPT}
</body>
</html>`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}