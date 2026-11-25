import publicSiteWorker from './pontdigital/worker.js';
import {
  handleBookingWebhook, handleInboundTwilio, handleAppointmentAction,
  runAppointmentCron, renderBookingRows, renderSmsRows, phone as normalizePdPhone
} from './appointments-integration.js';
import {saveMagazineIssue, toggleMagazineIssue, renderMagazinePanel} from './magazine-admin.js';
import {
  handleReadGoogleProfileApi,
  handleNyxiaDraftProfileApi,
  handleUpdateGoogleProfileRoute
} from './gbp-profile.js';

// ============================================================================
// PONT DIGITAL — SUPER ADMIN WORKER MODULAIRE (CLOUDFLARE WORKERS + D1)
// Assets externes : /images/FavIcon.png, /images/NyXia.png,
//                   /css/index.css, /css/admin.css, /js/starry-bg.js, /js/admin.js
// ============================================================================

const FAVICON_URL = '/images/FavIcon.png';
const NYXIA_AVATAR_URL = '/images/NyXia.png';
const INDEX_CSS_URL = '/css/index.css';
const ADMIN_CSS_URL = '/css/admin.css';
const STARRY_JS_URL = '/js/starry-bg.js';
const ADMIN_JS_URL = '/js/admin.js';

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      // Routage des deux domaines EXISTANTS vers les deux modules EXISTANTS.
      // Le domaine public n'a jamais acces aux routes du SuperAdmin.
      if (url.hostname.toLowerCase() === 'pontdigital.nyxia.top') {
        const publicPath = url.pathname;

        // API du module public : conserver les URLs utilisees par le site.
        if (publicPath.startsWith('/api/public/') ||
            /^\/entreprise\/\d+$/.test(publicPath) ||
            publicPath === '/api/nyxia/chat' ||
            publicPath === '/favicon.ico') {
          return publicSiteWorker.fetch(request, env);
        }

        // Site public uniquement : aucun acces aux autres fichiers et routes.
        // Les CSS/JS/images sont lus dans /pontdigital/ et non a la racine admin.
        const isPublicHome = publicPath === '/' ||
          publicPath === '/index.html' ||
          publicPath === '/pontdigital/' ||
          publicPath === '/pontdigital' ||
          publicPath === '/pontdigital/index.html';
        // Cloudflare sert index2.html sous l'URL canonique /pontdigital/index2.
        // Accepter les deux variantes et les anciennes URLs déjà utilisées.
        const isPublicAgency = publicPath === '/index2' ||
          publicPath === '/index2.html' ||
          publicPath === '/pontdigital/index2' ||
          publicPath === '/pontdigital/index2.html';
        const isPublicAsset = isPublicHome || isPublicAgency ||
          publicPath.startsWith('/css/') ||
          publicPath.startsWith('/js/') ||
          publicPath.startsWith('/images/');
        if (!isPublicAsset) {
          return new Response('Page introuvable', { status: 404 });
        }
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          return new Response('Methode non autorisee', { status: 405 });
        }
        const publicUrl = new URL(request.url);
        // Cloudflare redirige /pontdigital/index.html vers /pontdigital/.
        // Servir directement le chemin canonique interne évite une redirection
        // visible et une deuxième requête rejetée par le routage public.
        publicUrl.pathname = isPublicHome ? '/pontdigital/' :
          (isPublicAgency ? '/pontdigital/index2' : '/pontdigital' + publicPath);
        return publicSiteWorker.fetch(new Request(publicUrl.toString(), request), env);
      }
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
      // A et B : webhooks externes authentifies, avant la session SuperAdmin.
      if (path === '/webhook/booking' && request.method === 'POST') {
        return handleBookingWebhook(request, env);
      }
      if (path === '/webhook/twilio/sms' && request.method === 'POST') {
        return handleInboundTwilio(request, env, ctx);
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

      // 4. Callback OAuth Google Business Profile
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

      // 7. Actions Google Business Profile
      if (path === '/api/google/sync-reviews' && request.method === 'POST') {
        return handleSyncReviewsRoute(request, env);
      }
      if (path === '/api/google/create-post' && request.method === 'POST') {
        return handleCreateGooglePostRoute(request, env);
      }
      if (path === '/api/google/reply-review' && request.method === 'POST') {
        return handleReplyReviewWithNyxiaRoute(request, env);
      }
      if (path === '/api/google/read-profile' && request.method === 'GET') {
        return handleReadGoogleProfileApi(request, env, getGoogleAccessToken, jsonResponse);
      }
      if (path === '/api/google/update-profile' && request.method === 'POST') {
        return handleUpdateGoogleProfileRoute(request, env, getGoogleAccessToken);
      }

      // 8. Générateur IA NyXia universel par métier
      if (path === '/api/nyxia/draft-post' && request.method === 'POST') {
        return handleNyxiaDraftPostApi(request, env);
      }
      if (path === '/api/nyxia/draft-profile' && request.method === 'POST') {
        return handleNyxiaDraftProfileApi(request, env, jsonResponse);
      }

      // 9. Module Appointment Setter (RDV qualifiés + Invitations Google Agenda)
      if (path === '/api/setter/book' && request.method === 'POST') {
        return handleBookAppointmentRoute(request, env);
      }
      if (path === '/api/setter/delete' && request.method === 'POST') {
        return handleDeleteAppointmentRoute(request, env);
      }
      // C : confirmation par le Setter, prestation effectuee, avis autorise uniquement ensuite.
      if (path === '/api/appointments/action' && request.method === 'POST') {
        return handleAppointmentAction(request, env);
      }

      // 10. Test SMS & suivi des leads Heyzine
      if (path === '/api/test-nyxia-sms' && request.method === 'POST') {
        return handleTestNyxiaSmsRoute(request, env);
      }
      if (path === '/api/leads/status' && request.method === 'POST') {
        return handleUpdateLeadStatus(request, env);
      }

      // 11. Gestion des entrepreneurs & sécurité équipe
      if (path === '/api/change-password' && request.method === 'POST') {
        return handleChangePassword(request, env);
      }
      if (path === '/api/clients' && request.method === 'POST') {
        return handleAddClient(request, env);
      }
      if (path === '/api/clients/update' && request.method === 'POST') {
        return handleUpdateClientFull(request, env);
      }
      if (path === '/api/clients/toggle-status' && request.method === 'POST') {
        return handleToggleClientStatus(request, env);
      }
      if (path === '/api/magazine/save' && request.method === 'POST') return saveMagazineIssue(request, env);
      if (path === '/api/magazine/toggle' && request.method === 'POST') return toggleMagazineIssue(request, env);
      if (path === '/api/clients/delete' && request.method === 'POST') {
        return handleDeleteClient(request, env);
      }

      // 12. Chargement des données et affichage du Tableau de Bord à 4 onglets
      const { results: clients } = await env.DB.prepare(`
        SELECT c.*,
               (SELECT COUNT(*) FROM google_reviews r WHERE r.client_id = c.id) AS review_count,
               (SELECT COUNT(*) FROM google_posts p WHERE p.client_id = c.id) AS post_count,
               (SELECT COUNT(*) FROM heyzine_leads l WHERE l.client_id = c.id) AS lead_count,
               (SELECT COUNT(*) FROM appointments a WHERE a.client_id = c.id) AS rdv_count
        FROM clients c
        ORDER BY c.created_at DESC
      `).all();

      const { results: magazineIssues } = await env.DB.prepare('SELECT * FROM magazine_issues ORDER BY issue_month DESC').all();

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
      const {results: recentSms} = await env.DB.prepare(`
        SELECT m.*, c.business_name FROM pd_sms_messages m
        JOIN clients c ON c.id=m.client_id WHERE m.direction IN ('in','out')
        ORDER BY m.created_at DESC, m.id DESC LIMIT 25
      `).all();

      return new Response(
        renderDashboardHTML(clients, recentReviews, recentLeads, recentAppointments, url.searchParams.get('msg'), url.origin, magazineIssues, recentSms),
        { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
      );
    } catch (err) {
      return renderErrorHTML('Erreur technique interceptée', `${err.message}\n\n${err.stack || ''}`);
    }
  },

  async scheduled(event, env, ctx) {
    // Conserver la synchronisation des avis existante exactement a 06:00 UTC.
    if (event.cron === '0 6 * * *') ctx.waitUntil(syncAllConnectedClientsReviews(env));
    // Nouveau cron pour rappels et demandes d'avis uniquement.
    if (event.cron === '*/15 * * * *') ctx.waitUntil((async () => {
      await ensureDatabaseReady(env.DB);
      await runAppointmentCron(env);
    })());
  }
};

// ============================================================================
// BASE DE DONNÉES D1 (SCHÉMA EXACT + MIGRATIONS NON-DESTRUCTIVES)
// ============================================================================

async function ensureDatabaseReady(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS admin_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS magazine_issues (issue_month TEXT PRIMARY KEY, title TEXT NOT NULL, heyzine_url TEXT NOT NULL, cover_url TEXT, introduction TEXT, published INTEGER NOT NULL DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS clients (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        business_name TEXT NOT NULL,
        city TEXT NOT NULL,
        category TEXT NOT NULL,
        services TEXT,
        service_areas TEXT,
        gbp_description TEXT,
        gbp_hours_json TEXT,
        public_address TEXT,
        show_public_address INTEGER NOT NULL DEFAULT 0,
        advertorial_text TEXT,
        social_links TEXT,
        google_rating REAL,
        google_review_count INTEGER,
        phone TEXT,
        client_email TEXT,
        booking_calendar_url TEXT,
        booking_notes TEXT,
        twilio_sms_number TEXT,
        setter_alert_phone TEXT,
        google_review_url TEXT,
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
        external_booking_id TEXT,
        booking_source TEXT,
        booking_status TEXT,
        service_name TEXT,
        prospect_city TEXT,
        prospect_deadline TEXT,
        sms_consent INTEGER NOT NULL DEFAULT 0,
        review_sms_consent INTEGER NOT NULL DEFAULT 0,
        attendance_confirmed_at TEXT,
        service_completed_at TEXT,
        reminder_24h_status TEXT,
        reminder_2h_status TEXT,
        review_sms_status TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `),
    db.prepare(`CREATE TABLE IF NOT EXISTS pd_sms_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL,
      message_sid TEXT UNIQUE, phone_from TEXT, phone_to TEXT, body TEXT,
      direction TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`)
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
    'ALTER TABLE clients ADD COLUMN services TEXT',
    'ALTER TABLE clients ADD COLUMN service_areas TEXT',
    'ALTER TABLE clients ADD COLUMN gbp_description TEXT',
    'ALTER TABLE clients ADD COLUMN gbp_hours_json TEXT',
    'ALTER TABLE clients ADD COLUMN public_address TEXT',
    'ALTER TABLE clients ADD COLUMN show_public_address INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE clients ADD COLUMN advertorial_text TEXT',
    'ALTER TABLE clients ADD COLUMN social_links TEXT',
    'ALTER TABLE clients ADD COLUMN google_rating REAL',
    'ALTER TABLE clients ADD COLUMN google_review_count INTEGER',
    "ALTER TABLE google_posts ADD COLUMN topic_type TEXT DEFAULT 'STANDARD'",
    'ALTER TABLE google_posts ADD COLUMN media_url TEXT',
    "ALTER TABLE heyzine_leads ADD COLUMN handling_status TEXT DEFAULT 'nouveau'",
    // A/B/C : colonnes ajoutees sans suppression ni modification des donnees historiques.
    'ALTER TABLE clients ADD COLUMN twilio_sms_number TEXT',
    'ALTER TABLE clients ADD COLUMN setter_alert_phone TEXT',
    'ALTER TABLE clients ADD COLUMN google_review_url TEXT',
    'ALTER TABLE appointments ADD COLUMN external_booking_id TEXT',
    'ALTER TABLE appointments ADD COLUMN booking_source TEXT',
    'ALTER TABLE appointments ADD COLUMN booking_status TEXT',
    'ALTER TABLE appointments ADD COLUMN service_name TEXT',
    'ALTER TABLE appointments ADD COLUMN prospect_city TEXT',
    'ALTER TABLE appointments ADD COLUMN prospect_deadline TEXT',
    'ALTER TABLE appointments ADD COLUMN sms_consent INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE appointments ADD COLUMN review_sms_consent INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE appointments ADD COLUMN attendance_confirmed_at TEXT',
    'ALTER TABLE appointments ADD COLUMN service_completed_at TEXT',
    'ALTER TABLE appointments ADD COLUMN reminder_24h_status TEXT',
    'ALTER TABLE appointments ADD COLUMN reminder_2h_status TEXT',
    'ALTER TABLE appointments ADD COLUMN review_sms_status TEXT',
    'ALTER TABLE appointments ADD COLUMN updated_at TEXT'
  ];
  for (const sql of migrations) {
    try { await db.prepare(sql).run(); } catch (_) {}
  }
  await db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_pd_booking_external ON appointments(client_id,external_booking_id)').run();
  await db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_pd_twilio_unique ON clients(twilio_sms_number) WHERE twilio_sms_number IS NOT NULL AND twilio_sms_number <> ''").run();
}

// ============================================================================
// APPOINTMENT SETTER + GOOGLE WORKSPACE INVITATIONS
// ============================================================================

function buildGoogleCalendarInviteUrl({ title, startIso, durationMinutes, details, location, guests }) {
  const startDate = new Date(startIso);
  const validStart = isNaN(startDate.getTime()) ? new Date() : startDate;
  const endDate = new Date(validStart.getTime() + (durationMinutes || 30) * 60000);
  const fmt = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: title,
    dates: `${fmt(validStart)}/${fmt(endDate)}`,
    details,
    location
  });
  if (guests && guests.length > 0) params.set('add', guests.join(','));
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
  if (!client) return Response.redirect(new URL('/?msg=error_fields', request.url), 302);

  const guests = [client.client_email, prospectEmail].filter(Boolean);
  const gcalUrl = buildGoogleCalendarInviteUrl({
    title: `RDV Pont Digital — ${prospectName} x ${client.business_name}`,
    startIso: appointmentDatetime,
    durationMinutes,
    details: `Rendez-vous qualifié par l'équipe Pont Digital (NyXia).\n\nEntrepreneur : ${client.business_name} (${client.city})\nProspect : ${prospectName}\nTéléphone : ${prospectPhone || 'Non précisé'}\nCourriel : ${prospectEmail || 'Non précisé'}\n\nNotes de qualification du Setter :\n${setterNotes || 'Prospect qualifié prêt pour soumission / rencontre.'}`,
    location: `${client.city}, Québec (ou Google Meet)`,
    guests
  });

  await env.DB.prepare(`
    INSERT INTO appointments (client_id, prospect_name, prospect_email, prospect_phone, appointment_datetime, duration_minutes, setter_notes, gcal_event_url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(client.id, prospectName, prospectEmail, prospectPhone, appointmentDatetime, durationMinutes, setterNotes, gcalUrl).run();

  await env.DB.prepare(`
    UPDATE heyzine_leads SET handling_status = 'rdv_confirme'
    WHERE client_id = ? AND prospect_name LIKE ? AND handling_status != 'rdv_confirme'
  `).bind(client.id, `%${prospectName}%`).run();

  return Response.redirect(new URL('/?msg=rdv_booked', request.url), 302);
}

async function handleDeleteAppointmentRoute(request, env) {
  const formData = await request.formData();
  const id = formData.get('id');
  if (id) await env.DB.prepare('DELETE FROM appointments WHERE id = ?').bind(id).run();
  return Response.redirect(new URL('/?msg=rdv_deleted', request.url), 302);
}

// ============================================================================
// NYXIA — PROMPT MÉTIER UNIVERSEL POUR GOOGLE BUSINESS PROFILE
// ============================================================================

async function handleNyxiaDraftPostApi(request, env) {
  try {
    const body = await request.json();
    const clientId = body.client_id;
    const topicType = body.topic_type || 'STANDARD';
    const editorialAngle = body.editorial_angle || 'conseil_metier';
    const customTopic = String(body.angle || '').trim();

    if (!clientId) return jsonResponse({ error: 'Sélectionne d’abord un entrepreneur.' }, 400);
    const client = await env.DB.prepare('SELECT * FROM clients WHERE id = ?').bind(clientId).first();
    if (!client) return jsonResponse({ error: 'Client introuvable.' }, 404);

    const angleInstructions = {
      conseil_metier: "Donne un conseil pratique, concret et immédiatement utile lié au métier exact de l'entreprise (prévention, entretien, astuce de spécialiste) afin que le lecteur comprenne la valeur du savoir-faire avant même de téléphoner.",
      demystification: "Explique simplement comment se déroule une intervention, un soin ou une prestation typique de ce métier pour rassurer les clients qui hésitent ou ne savent pas par où commencer.",
      erreur_eviter: "Attire l'attention sur une erreur fréquente ou un réflexe coûteux que font les gens dans ce domaine, et explique brièvement comment un spécialiste règle le problème.",
      reportage_heyzine: "Mets en valeur son entrevue vidéo et son portrait exclusif dans la revue interactive Pont Digital pour donner envie de découvrir son approche humaine."
    };

    const fallbackText = `Chez ${client.business_name} à ${client.city}, notre priorité est de vous accompagner avec transparence en ${client.category}. Besoin d'un avis professionnel ou d'une rencontre ? Découvrez notre approche et réservez votre créneau dès aujourd'hui.`;

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
        'X-Title': 'Pont Digital - NyXia Editorial Engine'
      },
      body: JSON.stringify({
        model,
        temperature: 0.65,
        max_tokens: 320,
        messages: [
          {
            role: 'system',
            content:
              "Tu es NyXia, rédactrice en chef et stratège de contenu local pour Pont Digital au Québec. Ta mission est de prouver aux entrepreneurs locaux que leur fiche Google Business Profile attire de vrais clients lorsqu'on y publie du contenu éducatif pertinent plutôt que des annonces vides.\n" +
              "Règles impératives :\n" +
              "1. Adapte-toi automatiquement au métier exact de l'entreprise fournie en puisant dans les réalités concrètes de cette profession.\n" +
              "2. Commence par une accroche liée à un besoin réel ou une question que se posent les gens de sa ville, apporte une information utile de spécialiste, puis conclus par une invitation naturelle à contacter l'entreprise.\n" +
              "3. Intègre naturellement le nom de l'entreprise, sa ville et sa spécialité sans jamais faire de bourrage de mots-clés ni lister l'adresse physique.\n" +
              "4. Français québécois naturel, chaleureux et crédible. Longueur : 400 à 600 caractères maximum. Zéro hashtag (interdit sur Google Business Profile). Zéro guillemet autour du texte."
          },
          {
            role: 'user',
            content:
              `Entreprise : ${client.business_name}\n` +
              `Ville : ${client.city}\n` +
              `Métier / Spécialité : ${client.category}\n` +
              `Format Google : ${topicType}\n` +
              `Angle éditorial choisi : ${angleInstructions[editorialAngle] || angleInstructions.conseil_metier}\n` +
              `Précision ou sujet demandé : ${customTopic || 'Choisis le sujet le plus pertinent et utile pour ce métier en cette saison.'}`
          }
        ]
      })
    });

    const data = await res.json();
    const draft = data.choices?.[0]?.message?.content?.trim() || fallbackText;
    return jsonResponse({ draft, default_media: client.cover_photo_url || '', default_cta: client.heyzine_url || '' });
  } catch (e) {
    return jsonResponse({ error: 'Erreur lors de la rédaction par NyXia.' }, 500);
  }
}

// ============================================================================
// AVIS GOOGLE & RÉPONSE NYXIA EN 1 CLIC
// ============================================================================

async function handleReplyReviewWithNyxiaRoute(request, env) {
  const formData = await request.formData();
  const reviewId = formData.get('review_id');
  if (!reviewId) return Response.redirect(new URL('/?msg=error_fields', request.url), 302);

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
    const fullResource = normalizeFullLocationResource(row.google_account_name, row.google_location_name);
    if (!fullResource) return Response.redirect(new URL('/?msg=google_location_required', request.url), 302);

    const cleanReviewId = row.review_id.includes('/reviews/') ? row.review_id.split('/reviews/').pop() : row.review_id;
    const googleReplyRes = await fetch(
      `https://mybusiness.googleapis.com/v4/${fullResource}/reviews/${encodeURIComponent(cleanReviewId)}/reply`,
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ comment: replyText })
      }
    );
    if (!googleReplyRes.ok) return Response.redirect(new URL('/?msg=google_api_error', request.url), 302);

    await env.DB.prepare(`UPDATE google_reviews SET reply_comment = ?, synced_at = CURRENT_TIMESTAMP WHERE review_id = ?`)
      .bind(replyText, row.review_id).run();

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

  if (!env.OPENROUTER_API_KEY) return fallbackReply;
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
            content: 'Tu es NyXia, experte en réputation locale pour Pont Digital au Québec. Rédige une réponse officielle au nom de l’entreprise à un avis Google : ton chaleureux, humain et authentique en français québécois professionnel ; intègre naturellement le nom de l’entreprise, sa ville et son métier ; maximum 450 caractères ; aucun hashtag, aucun guillemet. Si la note est ≤ 3 étoiles, reste empathique et invite le client à contacter l’équipe directement.'
          },
          {
            role: 'user',
            content: `Entreprise : ${businessName}\nVille : ${city}\nMétier : ${category}\nAuteur : ${reviewerName}\nNote : ${starRating}/5\nCommentaire : ${comment || '(Aucun texte laissé)'}`
          }
        ]
      })
    });
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || fallbackReply;
  } catch (_) {
    return fallbackReply;
  }
}

// ============================================================================
// WEBHOOK HEYZINE PRO -> NYXIA -> SMS SETTER
// ============================================================================

async function handleHeyzineWebhook(request, env) {
  const url = new URL(request.url);
  if (env.HEYZINE_WEBHOOK_SECRET) {
    const providedToken = url.searchParams.get('token') || request.headers.get('X-Webhook-Token') || '';
    if (!timingSafeEqual(providedToken, env.HEYZINE_WEBHOOK_SECRET)) {
      return jsonResponse({ ok: false, error: 'Unauthorized webhook token' }, 401);
    }
  }

  let payload = {};
  const contentType = request.headers.get('Content-Type') || '';
  try {
    if (contentType.includes('application/json')) payload = await request.json();
    else if (contentType.includes('form')) payload = Object.fromEntries((await request.formData()).entries());
    else {
      const rawText = await request.text();
      payload = rawText ? JSON.parse(rawText) : {};
    }
  } catch (_) {
    return jsonResponse({ ok: false, error: 'Invalid payload format' }, 400);
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
  if (targetClientId) client = await env.DB.prepare('SELECT * FROM clients WHERE id = ?').bind(targetClientId).first();
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

  const result = await processLeadWithNyxiaAndSms({ env, client, prospectName, prospectContact, prospectMessage, sourceUrl });
  return jsonResponse({ ok: true, ...result }, 200);
}

async function handleTestNyxiaSmsRoute(request, env) {
  const formData = await request.formData();
  const clientId = formData.get('client_id');
  const prospectName = (formData.get('prospect_name') || 'Sophie Gagnon').trim();
  const prospectContact = (formData.get('prospect_contact') || '450-555-0142').trim();
  const prospectMessage = (formData.get('prospect_message') || 'Intéressée par vos services suite à la revue Heyzine !').trim();

  if (!clientId) return Response.redirect(new URL('/?msg=error_fields', request.url), 302);
  const client = await env.DB.prepare('SELECT * FROM clients WHERE id = ?').bind(clientId).first();
  if (!client) return Response.redirect(new URL('/?msg=error_fields', request.url), 302);

  await processLeadWithNyxiaAndSms({ env, client, prospectName, prospectContact, prospectMessage, sourceUrl: client.heyzine_url || 'Test SuperAdmin' });
  return Response.redirect(new URL('/?msg=lead_processed', request.url), 302);
}

async function handleUpdateLeadStatus(request, env) {
  const formData = await request.formData();
  const leadId = formData.get('lead_id');
  const handlingStatus = formData.get('handling_status') || 'nouveau';
  if (leadId) {
    await env.DB.prepare('UPDATE heyzine_leads SET handling_status = ? WHERE id = ?').bind(handlingStatus, leadId).run();
  }
  return Response.redirect(new URL('/?msg=lead_status_updated', request.url), 302);
}

async function processLeadWithNyxiaAndSms({ env, client, prospectName, prospectContact, prospectMessage, sourceUrl }) {
  const businessName = client ? `${client.business_name} (${client.city})` : 'Partenaire Pont Digital';
  const smsText = await generateNyxiaSmsAlert({ env, businessName, prospectName, prospectContact, prospectMessage });
  let smsStatus = 'agency_phone_missing';
  if (env.AGENCY_ALERT_PHONE) smsStatus = await sendTwilioSms(env, env.AGENCY_ALERT_PHONE, smsText);

  await env.DB.prepare(`
    INSERT INTO heyzine_leads (client_id, prospect_name, prospect_contact, prospect_message, source_url, nyxia_sms_text, sms_status, handling_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'nouveau')
  `).bind(client ? client.id : null, prospectName, prospectContact, prospectMessage, sourceUrl, smsText, smsStatus).run();

  return { client_matched: businessName, sms_status: smsStatus, sms_preview: smsText };
}

async function generateNyxiaSmsAlert({ env, businessName, prospectName, prospectContact, prospectMessage }) {
  const fallbackSms = `ALERTE PONT DIGITAL (NyXia) — Lead Setter pour ${businessName} : ${prospectName} (${prospectContact}) -> "${prospectMessage.slice(0, 100)}"`;
  if (!env.OPENROUTER_API_KEY) return fallbackSms;
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
            content: 'Tu es NyXia, assistante de l’agence Pont Digital. Rédige une alerte SMS interne ultra-rapide destinée aux Setters pour les prévenir d’un nouveau prospect à qualifier : maximum 280 caractères, français québécois clair, aucun hashtag, mentionne clairement le client Pont Digital concerné, le nom du prospect, ses coordonnées et sa demande.'
          },
          {
            role: 'user',
            content: `Client Pont Digital : ${businessName}\nProspect : ${prospectName}\nContact : ${prospectContact}\nDemande : ${prospectMessage}`
          }
        ]
      })
    });
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || fallbackSms;
  } catch (_) {
    return fallbackSms;
  }
}

async function sendTwilioSms(env, rawToPhone, bodyText) {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_FROM_NUMBER) return 'twilio_not_configured';
  const digits = rawToPhone.replace(/\D/g, '');
  const toPhone = digits.length === 10 ? `+1${digits}` : (rawToPhone.startsWith('+') ? rawToPhone : `+${digits}`);
  try {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`,
      {
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`),
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({ To: toPhone, From: env.TWILIO_FROM_NUMBER, Body: bodyText })
      }
    );
    return res.ok ? 'sent' : 'twilio_error';
  } catch (_) {
    return 'twilio_error';
  }
}

// ============================================================================
// GOOGLE BUSINESS PROFILE OAUTH + MULTI-FICHES + POSTS MULTI-FORMATS
// ============================================================================

async function handleGoogleOAuthStart(request, env) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return Response.redirect(new URL('/?msg=google_missing_keys', request.url), 302);
  }
  const url = new URL(request.url);
  const clientId = url.searchParams.get('client_id');
  if (!clientId) return Response.redirect(new URL('/?msg=error_fields', request.url), 302);

  const secret = env.SESSION_SECRET || env.MASTER_ADMIN_PASSWORD;
  const payload = `${clientId}:${Date.now() + 600000}`;
  const sig = await signHmac(payload, secret);
  const state = encodeURIComponent(`${payload}.${sig}`);
  const redirectUri = `${url.origin}/oauth/google/callback`;

  const googleAuthUrl =
    `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(env.GOOGLE_CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code` +
    `&scope=${encodeURIComponent('https://www.googleapis.com/auth/business.manage')}` +
    `&access_type=offline&prompt=consent&state=${state}`;

  return Response.redirect(googleAuthUrl, 302);
}

async function handleGoogleOAuthCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const rawState = url.searchParams.get('state');
  if (url.searchParams.get('error') || !code || !rawState) {
    return Response.redirect(new URL('/?msg=google_oauth_error', request.url), 302);
  }

  const decodedState = decodeURIComponent(rawState);
  const lastDot = decodedState.lastIndexOf('.');
  if (lastDot === -1) return Response.redirect(new URL('/?msg=google_oauth_error', request.url), 302);

  const payload = decodedState.slice(0, lastDot);
  const sig = decodedState.slice(lastDot + 1);
  const secret = env.SESSION_SECRET || env.MASTER_ADMIN_PASSWORD;
  if (!timingSafeEqual(sig, await signHmac(payload, secret))) {
    return Response.redirect(new URL('/?msg=google_oauth_error', request.url), 302);
  }

  const [dbClientId, expiresStr] = payload.split(':');
  if (Date.now() > parseInt(expiresStr, 10)) {
    return Response.redirect(new URL('/?msg=google_oauth_error', request.url), 302);
  }

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${url.origin}/oauth/google/callback`,
      grant_type: 'authorization_code'
    })
  });
  const tokenData = await tokenRes.json();
  if (!tokenRes.ok || !tokenData.access_token) {
    return Response.redirect(new URL('/?msg=google_oauth_error', request.url), 302);
  }

  if (tokenData.refresh_token) {
    await env.DB.prepare(`UPDATE clients SET google_refresh_token = ? WHERE id = ?`).bind(tokenData.refresh_token, dbClientId).run();
  }

  const locations = await listAllGoogleLocations(tokenData.access_token);
  if (locations.length === 1) {
    const loc = locations[0];
    await env.DB.prepare(`
      UPDATE clients SET google_account_name = ?, google_location_name = ?, google_location_title = ?, google_place_id = COALESCE(?, google_place_id)
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
  const clientId = new URL(request.url).searchParams.get('client_id');
  if (!clientId) return Response.redirect(new URL('/?msg=error_fields', request.url), 302);

  const client = await env.DB.prepare('SELECT * FROM clients WHERE id = ?').bind(clientId).first();
  if (!client || !client.google_refresh_token) {
    return Response.redirect(new URL('/?msg=google_not_connected', request.url), 302);
  }

  try {
    const accessToken = await getGoogleAccessToken(client.google_refresh_token, env);
    const locations = await listAllGoogleLocations(accessToken);
    return new Response(renderSelectLocationHTML(client, locations), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  } catch (_) {
    return Response.redirect(new URL('/?msg=google_api_error', request.url), 302);
  }
}

async function handleAssignGoogleLocationPost(request, env) {
  const formData = await request.formData();
  const clientId = formData.get('client_id');
  const packedLocation = formData.get('selected_location') || '';
  if (!clientId || !packedLocation) return Response.redirect(new URL('/?msg=error_fields', request.url), 302);

  const [accountName, locationName, placeId, title] = packedLocation.split('|||');
  await env.DB.prepare(`
    UPDATE clients SET google_account_name = ?, google_location_name = ?, google_place_id = COALESCE(NULLIF(?, ''), google_place_id), google_location_title = ?
    WHERE id = ?
  `).bind(accountName || null, locationName || null, placeId || '', title || null, clientId).run();

  return Response.redirect(new URL('/?msg=google_location_assigned', request.url), 302);
}

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
  if (!res.ok || !data.access_token) throw new Error('Impossible de renouveler le jeton Google.');
  return data.access_token;
}

async function listAllGoogleLocations(accessToken) {
  const results = [];
  try {
    const accountsRes = await fetch('https://mybusinessaccountmanagement.googleapis.com/v1/accounts', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const accounts = (await accountsRes.json()).accounts || [];
    for (const acc of accounts) {
      if (!acc.name) continue;
      let pageToken = '';
      do {
        const pageParam = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '';
        const locRes = await fetch(
          `https://mybusinessbusinessinformation.googleapis.com/v1/${acc.name}/locations?readMask=name,title,storefrontAddress,metadata&pageSize=100${pageParam}`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        const locData = await locRes.json();
        for (const loc of (locData.locations || [])) {
          const cityLabel = [loc.storefrontAddress?.locality || '', loc.storefrontAddress?.administrativeArea || ''].filter(Boolean).join(', ');
          results.push({
            accountName: acc.name,
            accountLabel: acc.accountName || acc.name,
            locationName: loc.name || '',
            title: loc.title || 'Établissement sans nom',
            cityLabel,
            placeId: loc.metadata?.placeId || ''
          });
        }
        pageToken = locData.nextPageToken || '';
      } while (pageToken);
    }
  } catch (_) {}
  return results;
}

function normalizeFullLocationResource(accountName, locationName) {
  if (!locationName) return null;
  if (locationName.startsWith('accounts/')) return locationName;
  if (accountName && locationName.startsWith('locations/')) return `${accountName}/${locationName}`;
  return locationName;
}

async function handleSyncReviewsRoute(request, env) {
  const clientId = (await request.formData()).get('client_id');
  if (!clientId) return Response.redirect(new URL('/?msg=error_fields', request.url), 302);
  const client = await env.DB.prepare('SELECT * FROM clients WHERE id = ?').bind(clientId).first();
  if (!client || !client.google_refresh_token) return Response.redirect(new URL('/?msg=google_not_connected', request.url), 302);

  try {
    await syncReviewsForClient(client, env);
    return Response.redirect(new URL('/?msg=reviews_synced', request.url), 302);
  } catch (_) {
    return Response.redirect(new URL('/?msg=google_api_error', request.url), 302);
  }
}

async function syncReviewsForClient(client, env) {
  const accessToken = await getGoogleAccessToken(client.google_refresh_token, env);
  const fullResource = normalizeFullLocationResource(client.google_account_name, client.google_location_name);
  if (!fullResource) throw new Error('Aucun établissement Google associé à ce client.');

  const reviewsRes = await fetch(`https://mybusiness.googleapis.com/v4/${fullResource}/reviews?pageSize=50`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const reviewsData = await reviewsRes.json();
  if (!reviewsRes.ok) throw new Error(reviewsData.error?.message || 'Erreur API Google Reviews');

  // Enregistrement officiel de la note globale Google et du nombre total réel d'avis
  const avgRating = typeof reviewsData.averageRating === 'number' ? reviewsData.averageRating : null;
  const totalCount = typeof reviewsData.totalReviewCount === 'number' ? reviewsData.totalReviewCount : null;
  if (avgRating !== null || totalCount !== null) {
    await env.DB.prepare(`
      UPDATE clients
      SET google_rating = COALESCE(?, google_rating),
          google_review_count = COALESCE(?, google_review_count)
      WHERE id = ?
    `).bind(avgRating, totalCount, client.id).run();
  }

  const starMap = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
  for (const rev of (reviewsData.reviews || [])) {
    await env.DB.prepare(`
      INSERT INTO google_reviews (review_id, client_id, reviewer_name, star_rating, comment, reply_comment, review_updated_at, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(review_id) DO UPDATE SET
        star_rating = excluded.star_rating, comment = excluded.comment, reply_comment = excluded.reply_comment,
        review_updated_at = excluded.review_updated_at, synced_at = CURRENT_TIMESTAMP
    `).bind(
      rev.reviewId || rev.name,
      client.id,
      rev.reviewer?.displayName || 'Client Google',
      starMap[rev.starRating] || 5,
      rev.comment || '',
      rev.reviewReply?.comment || null,
      rev.updateTime || rev.createTime || new Date().toISOString()
    ).run();
  }
}

async function syncAllConnectedClientsReviews(env) {
  await ensureDatabaseReady(env.DB);
  const { results: clients } = await env.DB.prepare('SELECT * FROM clients WHERE google_refresh_token IS NOT NULL AND google_location_name IS NOT NULL').all();
  for (const client of clients) {
    try { await syncReviewsForClient(client, env); } catch (_) {}
  }
}

function parseDateParts(dateStr) {
  const d = dateStr ? new Date(dateStr) : new Date();
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
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

  if (!clientId || !summary) return Response.redirect(new URL('/?msg=error_fields', request.url), 302);
  const client = await env.DB.prepare('SELECT * FROM clients WHERE id = ?').bind(clientId).first();
  if (!client || !client.google_refresh_token) return Response.redirect(new URL('/?msg=google_not_connected', request.url), 302);

  const fullResource = normalizeFullLocationResource(client.google_account_name, client.google_location_name);
  if (!fullResource) return Response.redirect(new URL('/?msg=google_location_required', request.url), 302);

  if (!ctaUrl && client.heyzine_url) ctaUrl = client.heyzine_url;
  if (!mediaUrl && useClientCover && client.cover_photo_url) mediaUrl = client.cover_photo_url;

  try {
    const accessToken = await getGoogleAccessToken(client.google_refresh_token, env);

    const postBody = { languageCode: 'fr-CA', summary, topicType };
    if (topicType === 'EVENT' || topicType === 'OFFER') {
      postBody.event = {
        title: eventTitle || `${client.business_name} — ${topicType === 'OFFER' ? 'Offre spéciale' : 'Événement'}`,
        schedule: { startDate: parseDateParts(startDate), endDate: parseDateParts(endDate || startDate) }
      };
    }
    if (topicType === 'OFFER' && (couponCode || ctaUrl)) {
      postBody.offer = { ...(couponCode ? { couponCode } : {}), ...(ctaUrl ? { redeemOnlineUrl: ctaUrl } : {}) };
    }
    if (ctaUrl && topicType !== 'OFFER') postBody.callToAction = { actionType, url: ctaUrl };
    if (mediaUrl) postBody.media = [{ mediaFormat: 'PHOTO', sourceUrl: mediaUrl }];

    const postRes = await fetch(`https://mybusiness.googleapis.com/v4/${fullResource}/localPosts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(postBody)
    });
    const postData = await postRes.json();
    if (!postRes.ok) return Response.redirect(new URL('/?msg=google_api_error', request.url), 302);

    await env.DB.prepare(`INSERT INTO google_posts (client_id, google_post_name, topic_type, summary, cta_url, media_url) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(client.id, postData.name || null, topicType, summary, ctaUrl || null, mediaUrl || null).run();

    return Response.redirect(new URL('/?msg=post_published', request.url), 302);
  } catch (_) {
    return Response.redirect(new URL('/?msg=google_api_error', request.url), 302);
  }
}

// ============================================================================
// AUTHENTIFICATION & GESTION DES ENTREPRENEURS
// ============================================================================

async function handleLogin(request, env) {
  if (!env.MASTER_ADMIN_PASSWORD) {
    return new Response(renderLoginHTML('Variable MASTER_ADMIN_PASSWORD manquante dans Cloudflare.'), {
      status: 500, headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }
  const inputPassword = (await request.formData()).get('password') || '';
  let valid = timingSafeEqual(inputPassword, env.MASTER_ADMIN_PASSWORD);

  if (!valid) {
    const stored = await env.DB.prepare("SELECT value FROM admin_settings WHERE key = 'team_password_hash'").first();
    if (stored && stored.value) valid = await verifyPasswordHash(inputPassword, stored.value);
  }
  if (!valid) {
    return new Response(renderLoginHTML('Mot de passe invalide.'), {
      status: 401, headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }

  const token = await createSessionToken(env.SESSION_SECRET || env.MASTER_ADMIN_PASSWORD);
  return new Response(null, {
    status: 302,
    headers: { 'Location': '/', 'Set-Cookie': `pd_session=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200` }
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
    INSERT INTO admin_settings (key, value, updated_at) VALUES ('team_password_hash', ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).bind(hashed).run();
  return Response.redirect(new URL('/?msg=pwd_updated', request.url), 302);
}

function buildSocialLinksJson(formData) {
  const links = {
    website: (formData.get('social_website') || '').trim(),
    facebook: (formData.get('social_facebook') || '').trim(),
    instagram: (formData.get('social_instagram') || '').trim(),
    linkedin: (formData.get('social_linkedin') || '').trim(),
    tiktok: (formData.get('social_tiktok') || '').trim(),
    youtube: (formData.get('social_youtube') || '').trim()
  };
  return JSON.stringify(links);
}

async function handleAddClient(request, env) {
  const formData = await request.formData();
  const businessName = (formData.get('business_name') || '').trim();
  const city = (formData.get('city') || '').trim();
  const category = (formData.get('category') || '').trim();
  if (!businessName || !city || !category) return Response.redirect(new URL('/?msg=error_fields', request.url), 302);
  const assignedTwilio = normalizePdPhone(formData.get('twilio_sms_number'));
  if (assignedTwilio && await env.DB.prepare('SELECT id FROM clients WHERE twilio_sms_number=?').bind(assignedTwilio).first()) {
    return Response.redirect(new URL('/?msg=twilio_already_assigned', request.url), 302);
  }

  const galleryJson = JSON.stringify((formData.get('gallery_urls') || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 5));
  const socialJson = buildSocialLinksJson(formData);

  await env.DB.prepare(`
    INSERT INTO clients (business_name, city, category, services, service_areas, public_address, show_public_address, advertorial_text, social_links, phone, client_email, booking_calendar_url, booking_notes, heyzine_url, interview_video_url, cover_photo_url, gallery_urls,
      twilio_sms_number, setter_alert_phone, google_review_url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    businessName, city, category,
    (formData.get('services') || '').trim(),
    (formData.get('service_areas') || '').trim(),
    (formData.get('public_address') || '').trim(),
    formData.get('show_public_address') === '1' ? 1 : 0,
    (formData.get('advertorial_text') || '').trim(),
    socialJson,
    (formData.get('phone') || '').trim(),
    (formData.get('client_email') || '').trim(),
    (formData.get('booking_calendar_url') || '').trim(),
    (formData.get('booking_notes') || '').trim(),
    (formData.get('heyzine_url') || '').trim(),
    (formData.get('interview_video_url') || '').trim(),
    (formData.get('cover_photo_url') || '').trim(),
    galleryJson,
    normalizePdPhone(formData.get('twilio_sms_number')),
    normalizePdPhone(formData.get('setter_alert_phone')),
    (formData.get('google_review_url') || '').trim()
  ).run();

  return Response.redirect(new URL('/?msg=client_added', request.url), 302);
}

async function handleUpdateClientFull(request, env) {
  const formData = await request.formData();
  const clientId = formData.get('client_id');
  const businessName = (formData.get('business_name') || '').trim();
  const city = (formData.get('city') || '').trim();
  const category = (formData.get('category') || '').trim();
  if (!clientId || !businessName || !city || !category) return Response.redirect(new URL('/?msg=error_fields', request.url), 302);
  const assignedTwilio = normalizePdPhone(formData.get('twilio_sms_number'));
  if (assignedTwilio && await env.DB.prepare('SELECT id FROM clients WHERE twilio_sms_number=? AND id<>?').bind(assignedTwilio,clientId).first()) {
    return Response.redirect(new URL('/?msg=twilio_already_assigned', request.url), 302);
  }

  const galleryJson = JSON.stringify((formData.get('gallery_urls') || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 5));
  const socialJson = buildSocialLinksJson(formData);

  await env.DB.prepare(`
    UPDATE clients SET business_name = ?, city = ?, category = ?, services = ?, service_areas = ?,
      public_address = ?, show_public_address = ?, advertorial_text = ?, social_links = ?, phone = ?, client_email = ?,
      booking_calendar_url = ?, booking_notes = ?, heyzine_url = ?, interview_video_url = ?, cover_photo_url = ?, gallery_urls = ?,
      twilio_sms_number = ?, setter_alert_phone = ?, google_review_url = ?
    WHERE id = ?
  `).bind(
    businessName, city, category,
    (formData.get('services') || '').trim(),
    (formData.get('service_areas') || '').trim(),
    (formData.get('public_address') || '').trim(),
    formData.get('show_public_address') === '1' ? 1 : 0,
    (formData.get('advertorial_text') || '').trim(),
    socialJson,
    (formData.get('phone') || '').trim(),
    (formData.get('client_email') || '').trim(),
    (formData.get('booking_calendar_url') || '').trim(),
    (formData.get('booking_notes') || '').trim(),
    (formData.get('heyzine_url') || '').trim(),
    (formData.get('interview_video_url') || '').trim(),
    (formData.get('cover_photo_url') || '').trim(),
    galleryJson,
    normalizePdPhone(formData.get('twilio_sms_number')),
    normalizePdPhone(formData.get('setter_alert_phone')),
    (formData.get('google_review_url') || '').trim(), clientId
  ).run();

  return Response.redirect(new URL('/?msg=media_updated', request.url), 302);
}

async function handleToggleClientStatus(request, env) {
  const formData = await request.formData();
  const id = formData.get('id');
  if (id) {
    const client = await env.DB.prepare('SELECT status FROM clients WHERE id = ?').bind(id).first();
    if (client) {
      const nextStatus = (client.status === 'inactive') ? 'active' : 'inactive';
      await env.DB.prepare('UPDATE clients SET status = ? WHERE id = ?').bind(nextStatus, id).run();
    }
  }
  return Response.redirect(new URL('/?msg=client_status_updated', request.url), 302);
}

async function handleDeleteClient(request, env) {
  const id = (await request.formData()).get('id');
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
// CRYPTOGRAPHIE & UTILITAIRES
// ============================================================================

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const derivedBits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, keyMaterial, 256);
  return `${bufferToHex(salt)}:${bufferToHex(new Uint8Array(derivedBits))}`;
}

async function verifyPasswordHash(password, storedValue) {
  const [saltHex, originalHashHex] = storedValue.split(':');
  if (!saltHex || !originalHashHex) return false;
  const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const derivedBits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: hexToBuffer(saltHex), iterations: 100000, hash: 'SHA-256' }, keyMaterial, 256);
  return timingSafeEqual(bufferToHex(new Uint8Array(derivedBits)), originalHashHex);
}

async function createSessionToken(secret) {
  const payload = `admin:${Date.now() + 43200 * 1000}`;
  return `${payload}.${await signHmac(payload, secret)}`;
}

async function verifySession(request, env) {
  const secret = env.SESSION_SECRET || env.MASTER_ADMIN_PASSWORD;
  if (!secret) return false;
  const match = (request.headers.get('Cookie') || '').match(/pd_session=([^;]+)/);
  if (!match) return false;
  const token = match[1];
  const lastDot = token.lastIndexOf('.');
  if (lastDot === -1) return false;
  const payload = token.slice(0, lastDot);
  if (!timingSafeEqual(token.slice(lastDot + 1), await signHmac(payload, secret))) return false;
  return Date.now() < parseInt(payload.split(':')[1], 10);
}

async function signHmac(data, secret) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return bufferToHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))));
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

function bufferToHex(buf) { return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join(''); }
function hexToBuffer(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  return bytes;
}
function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}
function escapeHtml(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ============================================================================
// HEAD & INTERFACES HTML LÉGÈRES (4 ONGLETS + ASSETS EXTERNES)
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
  <link rel="stylesheet" href="${INDEX_CSS_URL}">
  <link rel="stylesheet" href="${ADMIN_CSS_URL}">`;
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
</html>`, { status: 500, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function renderLoginHTML(error = '') {
  return `<!DOCTYPE html>
<html lang="fr">
<head>${renderSharedHead('Connexion • SuperAdmin Pont Digital')}</head>
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
<head>${renderSharedHead('Associer une fiche Google • Pont Digital')}</head>
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

function renderHoursTableRows() {
  const days = [
    ['MONDAY', 'Lundi'],
    ['TUESDAY', 'Mardi'],
    ['WEDNESDAY', 'Mercredi'],
    ['THURSDAY', 'Jeudi'],
    ['FRIDAY', 'Vendredi'],
    ['SATURDAY', 'Samedi'],
    ['SUNDAY', 'Dimanche']
  ];
  return days.map(([code, label]) => `
    <tr>
      <td style="font-weight:600;color:#fff;white-space:nowrap;">${label}</td>
      <td><input type="time" id="day_${code}_open1" name="day_${code}_open1" value=""></td>
      <td><input type="time" id="day_${code}_close1" name="day_${code}_close1" value=""></td>
      <td><input type="time" id="day_${code}_open2" name="day_${code}_open2" value=""></td>
      <td><input type="time" id="day_${code}_close2" name="day_${code}_close2" value=""></td>
      <td><button type="button" class="btn-sm btn-ghost" onclick="clearDayHours('${code}')">Fermé</button></td>
    </tr>
  `).join('');
}

function renderDashboardHTML(clients, recentReviews, recentLeads, recentAppointments, msg, origin, magazineIssues, recentSms = []) {
  const alerts = {
    pwd_updated: 'Mot de passe interne mis à jour avec succès dans D1.',
    error_pwd: 'Erreur : le mot de passe doit contenir au moins 8 caractères et être identique.',
    client_added: 'Entrepreneur ajouté à la base D1 Pont Digital.',
    media_updated: 'Fiche entrepreneur, Agenda Workspace & Médias mis à jour !',
    client_deleted: 'Fiche entrepreneur supprimée.',
    client_status_updated: 'Visibilité de la fiche commerciale (Active / Désactivée) mise à jour !',
    error_fields: 'Veuillez remplir les champs obligatoires ou cocher au moins une section à mettre à jour.',
    google_connected: 'Fiche Google Business Profile connectée avec succès !',
    google_location_assigned: 'Établissement Google Agence associé avec succès !',
    google_location_required: 'Sécurité multi-fiches : associe d’abord la fiche Google précise de cet entrepreneur (« Changer fiche ») avant toute action Google.',
    google_oauth_error: 'La connexion Google Business Profile a échoué ou a été annulée.',
    google_missing_keys: 'Configuration requise : ajoute GOOGLE_CLIENT_ID et GOOGLE_CLIENT_SECRET dans Cloudflare.',
    google_not_connected: 'Connecte d’abord la fiche Google GBP de ce client.',
    reviews_synced: 'Avis Google synchronisés et enregistrés dans D1 !',
    review_replied: 'Réponse rédigée par NyXia et publiée sur Google Maps !',
    post_published: 'Publication diffusée sur la fiche Google Business Profile du client !',
    profile_updated: 'Fiche Google Business Profile mise à jour !',
    profile_updated_verified: '✓ Fiche Google Business Profile mise à jour, valeurs confirmées à l’identique sur Google et synchronisées dans D1 !',
    profile_updated_pending: '⏳ Requête acceptée par Google, mais les nouvelles valeurs ne sont pas encore visibles (modération Google en cours). D1 conserve l’état actuel.',
    hours_empty_blocked: '⚠️ Sécurité horaires : impossible d’envoyer des horaires réguliers entièrement vides. Renseigne au moins une plage ou décoche la case.',
    special_hours_empty_blocked: '⚠️ Sécurité horaires spéciaux : suppression annulée faute de confirmation explicite.',
    profile_d1_only: 'Services et territoire desservi enregistrés dans D1 pour le répertoire public !',
    google_api_error: 'Erreur de communication avec l’API Google Business Profile.',
    lead_processed: 'Alerte SMS envoyée par NyXia vers ton cellulaire et lead enregistré.',
    lead_status_updated: 'Statut de suivi du lead mis à jour.',
    rdv_booked: 'Rendez-vous qualifié enregistré ! Clique sur « 📅 Invitation Google Agenda ↗ » dans le journal.',
    rdv_deleted: 'Rendez-vous retiré du journal.',
    magazine_saved: 'Édition de la revue enregistrée.',
    magazine_invalid: 'Vérifie le mois, le titre et l’URL Heyzine (https://heyzine.com/...).',
    booking_updated: "Statut du rendez-vous mis à jour dans Pont Digital (l'agenda externe conserve ses propres rendez-vous).",
    twilio_already_assigned: 'Ce numéro SMS Twilio est déjà attribué à une autre entreprise. Aucune modification enregistrée.'
  };

  const gbpConnectedCount = clients.filter(c => Boolean(c.google_refresh_token)).length;
  const bookingReadyCount = clients.filter(c => Boolean(c.booking_calendar_url)).length;
  const pendingReviewsCount = recentReviews.filter(r => !r.reply_comment).length;

  const connectedClients = clients.filter(c => Boolean(c.google_refresh_token));
  const connectedOptions = connectedClients.map(c =>
    `<option value="${c.id}" data-location="${escapeHtml(c.google_location_title || 'Non associée')}">${escapeHtml(c.business_name)} (${escapeHtml(c.city)}) — ${escapeHtml(c.google_location_title || 'Fiche à associer')}</option>`
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

    const isActive = (c.status !== 'inactive');
    const ratingBadge = (c.google_rating !== null && c.google_rating !== undefined)
      ? `<span style="color:var(--gold);font-weight:600;">★ ${Number(c.google_rating).toFixed(1)} (${c.google_review_count ?? c.review_count ?? 0} avis)</span>`
      : `${c.review_count || 0} avis`;

    // SÉCURITÉ : seuls les champs d'édition sont transmis au navigateur (aucun jeton Google exposé dans le HTML)
    const safeClientForEdit = {
      id: c.id,
      business_name: c.business_name || '',
      city: c.city || '',
      category: c.category || '',
      services: c.services || '',
      service_areas: c.service_areas || '',
      public_address: c.public_address || '',
      show_public_address: Number(c.show_public_address || 0),
      advertorial_text: c.advertorial_text || '',
      social_links: c.social_links || '{}',
      phone: c.phone || '',
      client_email: c.client_email || '',
      booking_calendar_url: c.booking_calendar_url || '',
      twilio_sms_number: c.twilio_sms_number || '',
      setter_alert_phone: c.setter_alert_phone || '',
      google_review_url: c.google_review_url || '',
      heyzine_url: c.heyzine_url || '',
      interview_video_url: c.interview_video_url || '',
      cover_photo_url: c.cover_photo_url || '',
      booking_notes: c.booking_notes || '',
      gallery_urls: c.gallery_urls || '[]'
    };

    return `
      <tr style="${isActive ? '' : 'opacity:.62;'}">
        <td>
          <div style="display:flex;align-items:center;gap:10px;">
            ${c.cover_photo_url ? `<img src="${escapeHtml(c.cover_photo_url)}" alt="" style="width:40px;height:40px;border-radius:10px;object-fit:cover;border:1px solid var(--border);flex-shrink:0;">` : ''}
            <div>
              <strong style="color:#fff;font-size:.96rem;">${escapeHtml(c.business_name)}</strong>
              <span style="color:var(--gold);font-size:.75rem;">#${c.id}</span>
              ${isActive
                ? `<span class="pill pill-ok" style="margin-left:6px;padding:2px 8px;font-size:.68rem;">Active</span>`
                : `<span class="pill pill-muted" style="margin-left:6px;padding:2px 8px;font-size:.68rem;">Désactivée</span>`}
              <div style="font-size:.8rem;color:var(--text-muted);">${escapeHtml(c.category)} • ${escapeHtml(c.city)}</div>
              ${c.public_address ? `<div style="font-size:.75rem;color:var(--text-secondary);">🏠 ${escapeHtml(c.public_address)}</div>` : ''}
              ${c.service_areas ? `<div style="font-size:.75rem;color:var(--primary-light);">📍 ${escapeHtml(c.service_areas)}</div>` : ''}
              <div style="font-size:.76rem;color:var(--text-secondary);">${c.rdv_count || 0} RDV • ${c.lead_count || 0} leads • ${ratingBadge} • ${photosCount} photo(s)</div>
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
            <button type="button" class="btn-sm btn-ghost" onclick="copyWebhook('${escapeHtml(webhookClientUrl)}', this)">📋 Copier Webhook #${c.id}</button>
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
            <button type="button" class="btn-sm btn-ghost" onclick='openEditModal(${JSON.stringify(safeClientForEdit).replace(/'/g, "&#39;")})'>✏️ Modifier</button>
            <form method="POST" action="/api/clients/toggle-status" style="margin:0;">
              <input type="hidden" name="id" value="${c.id}">
              <button type="submit" class="btn-sm btn-ghost">${isActive ? '⏸️ Désactiver' : '▶️ Activer'}</button>
            </form>
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
      <td style="font-size:.82rem;color:var(--text-secondary);max-width:240px;">${escapeHtml(a.setter_notes || '')}${renderBookingRows(a)}</td>
      <td>
        <div class="actions-stack">
          ${a.gcal_event_url ? `<a href="${escapeHtml(a.gcal_event_url)}" target="_blank" rel="noopener" class="btn-sm btn-gold">${a.external_booking_id ? '📅 Ouvrir le RDV dans l’agenda ↗' : '📅 Invitation Google Agenda ↗'}</a>` : '<span class="pill pill-muted">RDV reçu de l’agenda</span>'}
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
          <div style="font-size:.76rem;color:var(--text-secondary);max-width:320px;">${escapeHtml(l.nyxia_sms_text || l.prospect_message || '')}</div>
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
<head>${renderSharedHead('SuperAdmin • Pont Digital')}</head>
<body>
  ${renderBackgroundLayer()}

  <header class="site-header">
    <a href="/" class="brand">
      <img src="${NYXIA_AVATAR_URL}" alt="NyXia • Pont Digital">
      <div class="brand-name">
        <b>PONT DIGITAL • SUPER ADMIN</b>
        <span>Gestion Agence, GBP &amp; Appointment Setting</span>
      </div>
    </a>
    <div class="header-right">
      <button type="button" class="btn-ghost" onclick="switchTab('settings')">📱 Tester SMS &amp; Sécurité</button>
      <a href="/logout" class="btn-primary">Déconnexion</a>
    </div>
  </header>

  <main class="admin-wrap">
    ${msg && alerts[msg] ? `<div class="alert-banner">${alerts[msg]}</div>` : ''}

    <!-- KPI BAR -->
    <div class="kpi-grid">
      <div class="kpi-box"><div class="kpi-label">Entrepreneurs actifs</div><div class="kpi-val">${clients.length}</div></div>
      <div class="kpi-box"><div class="kpi-label">Agendas Setting prêts</div><div class="kpi-val">${bookingReadyCount} / ${clients.length}</div></div>
      <div class="kpi-box"><div class="kpi-label">Fiches Google connectées</div><div class="kpi-val">${gbpConnectedCount} / ${clients.length}</div></div>
      <div class="kpi-box"><div class="kpi-label">Avis en attente de réponse</div><div class="kpi-val">${pendingReviewsCount}</div></div>
    </div>

    <!-- NAVIGATION : 4 ONGLETS EXISTANTS + REVUE -->
    <nav class="tabs-nav" aria-label="Sections Super Admin">
      <button type="button" class="tab-btn active" data-tab="clients" onclick="switchTab('clients')">🏢 Entrepreneurs &amp; Agendas (${clients.length})</button>
      <button type="button" class="tab-btn" data-tab="setting" onclick="switchTab('setting')">📅 Appointment Setting &amp; Leads (${recentAppointments.length + recentLeads.length})</button>
      <button type="button" class="tab-btn" data-tab="gbp" onclick="switchTab('gbp')">✨ Studio Google &amp; NyXia (${pendingReviewsCount})</button>
      <button type="button" class="tab-btn" data-tab="settings" onclick="switchTab('settings')">⚙️ Tests SMS &amp; Sécurité</button>
      <button type="button" class="tab-btn" data-tab="magazine" onclick="switchTab('magazine')">📖 Revue &amp; Archives</button>
    </nav>

    <!-- ONGLET 1 : ENTREPRENEURS & AGENDAS -->
    <div id="panel-clients" class="tab-panel active">
      <section class="admin-card">
        <h2 class="display" style="font-size:1.75rem;color:var(--gold);margin-bottom:14px;">+ Ajouter un entrepreneur au réseau Pont Digital</h2>
        <form method="POST" action="/api/clients">
          <div class="field-grid">
            <div class="field"><label>Nom de l'entreprise *</label><input name="business_name" required placeholder="Ex: Salon Éclat"></div>
            <div class="field"><label>Ville principale *</label><input name="city" required placeholder="Ex: Saint-Calixte"></div>
            <div class="field"><label>Catégorie principale *</label><input name="category" required placeholder="Ex: Salon de coiffure"></div>
            <div class="field"><label>Services précis (moteur de recherche)</label><input name="services" placeholder="Ex: coloration, mèches, coupe homme, coiffure de mariage"></div>
            <div class="field"><label>Territoire desservi (villes / région)</label><input name="service_areas" placeholder="Ex: Saint-Calixte, Sainte-Julienne, Rawdon, Lanaudière"></div>
            <div class="field"><label>Téléphone public</label><input name="phone" placeholder="514-000-0000"></div>
            <div class="field"><label>Courriel vendeur (invitations RDV)</label><input type="email" name="client_email" placeholder="contact@entreprise.ca"></div>
            <div class="field"><label>Lien Prise de RDV Google Workspace (Setter)</label><input type="url" name="booking_calendar_url" placeholder="https://calendar.app.google/..."></div>
            <div class="field"><label>Numéro SMS Twilio de CETTE entreprise (+1...)</label><input name="twilio_sms_number" placeholder="+15145551234"></div>
            <div class="field"><label>Téléphone d'alerte Setter (optionnel ; sinon agence)</label><input name="setter_alert_phone" placeholder="+15145551234"></div>
            <div class="field"><label>Lien direct pour laisser un avis Google (fourni par l'entreprise)</label><input type="url" name="google_review_url" placeholder="https://..."></div>
            <div class="field"><label>URL Page Heyzine (#page/X)</label><input type="url" name="heyzine_url" placeholder="https://heyzine.com/flip-book/...#page/1"></div>
            <div class="field"><label>URL Vidéo entrevue (YouTube/Vimeo/MP4)</label><input type="url" name="interview_video_url" placeholder="https://..."></div>
            <div class="field"><label>URL Photo couverture principale</label><input type="url" name="cover_photo_url" placeholder="https://..."></div>
          </div>
          <div class="field-grid" style="margin-top:14px;">
            <div class="field"><label>Adresse de l’établissement (affichée seulement si autorisée)</label><input name="public_address" placeholder="Ex: 123 Rue Principale, Saint-Calixte, QC J0K 1Z0"></div>
            <div class="field"><label class="check-row"><input type="checkbox" name="show_public_address" value="1"> Autoriser l’affichage de l’adresse sur le répertoire public</label></div>
            <div class="field"><label>Site web officiel</label><input type="url" name="social_website" placeholder="https://..."></div>
            <div class="field"><label>Page Facebook</label><input type="url" name="social_facebook" placeholder="https://facebook.com/..."></div>
            <div class="field"><label>Instagram</label><input type="url" name="social_instagram" placeholder="https://instagram.com/..."></div>
            <div class="field"><label>LinkedIn</label><input type="url" name="social_linkedin" placeholder="https://linkedin.com/..."></div>
            <div class="field"><label>TikTok</label><input type="url" name="social_tiktok" placeholder="https://tiktok.com/@..."></div>
            <div class="field"><label>YouTube</label><input type="url" name="social_youtube" placeholder="https://youtube.com/@..."></div>
          </div>
          <div class="field-grid" style="margin-top:14px;">
            <div class="field"><label>Consignes pour les setters (script / critères qualification)</label><input name="booking_notes" placeholder="Ex: RDV découverte 20 min, secteur Rive-Nord uniquement"></div>
            <div class="field"><label>Photos galerie (jusqu'à 5 URLs séparées par une virgule)</label><input name="gallery_urls" placeholder="https://img1.jpg, https://img2.jpg"></div>
          </div>
          <div class="field" style="margin-top:14px;">
            <label>Texte narratif du publireportage (fiche commerciale publique)</label>
            <textarea name="advertorial_text" rows="3" placeholder="Histoire de l'entrepreneur, mission, approche humaine et ce qui le distingue dans sa région..."></textarea>
          </div>
          <div style="margin-top:16px;"><button type="submit" class="btn-primary">Enregistrer l'entrepreneur</button></div>
        </form>
      </section>

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
            <tbody>${clientsRows || '<tr><td colspan="4" style="color:var(--text-muted);text-align:center;padding:24px;">Aucun entrepreneur enregistré.</td></tr>'}</tbody>
          </table>
        </div>
      </section>
    </div>

    <!-- ONGLET 2 : APPOINTMENT SETTING & LEADS HEYZINE -->
    <div id="panel-setting" class="tab-panel">
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
              <tr><th>Client</th><th>Prospect</th><th>Créneau</th><th>Notes</th><th>Invitation &amp; Action</th></tr>
            </thead>
            <tbody>${apptRows || '<tr><td colspan="5" style="color:var(--text-muted);text-align:center;padding:18px;">Aucun rendez-vous enregistré.</td></tr>'}</tbody>
          </table>
        </div>
      </section>

      <section class="admin-card">
        <h2 class="display" style="font-size:1.4rem;color:#fff;margin-bottom:14px;">B • SMS entrants et sortants des prospects (Twilio)</h2>
        <div class="table-scroll"><table class="pd-table"><thead><tr><th>Entreprise</th><th>Telephone prospect</th><th>Message</th><th>Date UTC</th></tr></thead><tbody>${renderSmsRows(recentSms)}</tbody></table></div>
      </section>
      <section class="admin-card">
        <h2 class="display" style="font-size:1.75rem;color:#fff;margin-bottom:14px;">Demandes entrantes depuis la Revue Heyzine</h2>
        <div class="table-scroll">
          <table class="pd-table">
            <thead><tr><th>Prospect</th><th>Entreprise &amp; Alerte SMS NyXia</th><th>Suivi Setter</th></tr></thead>
            <tbody>${leadsRows || '<tr><td colspan="3" style="color:var(--text-muted);text-align:center;padding:18px;">Aucune demande entrante enregistrée.</td></tr>'}</tbody>
          </table>
        </div>
      </section>
    </div>

    <!-- ONGLET 3 : STUDIO GOOGLE BUSINESS & NYXIA UNIVERSELLE -->
    <div id="panel-gbp" class="tab-panel">
      <section class="admin-card">
        <h2 class="display" style="font-size:1.75rem;color:var(--gold);margin-bottom:14px;">Studio Google Business Profile • Rédaction Métier par NyXia</h2>
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
              <label>Angle éditorial métier (NyXia s'adapte au métier)</label>
              <select id="post-editorial-angle">
                <option value="conseil_metier">💡 Conseil pratique / Prévention métier</option>
                <option value="demystification">🔍 Démystifier un service / Intervention</option>
                <option value="erreur_eviter">⚠️ Erreur fréquente à éviter</option>
                <option value="reportage_heyzine">🎬 Reportage &amp; Entrevue Pont Digital</option>
              </select>
            </div>
            <div class="field">
              <label>Sujet ou précision du moment (optionnel)</label>
              <input id="post-custom-topic" placeholder="Ex: Entretien printemps, première visite, urgence...">
            </div>
            <div class="field">
              <label>Format de publication Google</label>
              <select id="post-topic-type" name="topic_type" onchange="togglePostFields()">
                <option value="STANDARD">📰 Actualité / Conseil Métier</option>
                <option value="OFFER">🎁 Offre Spéciale / Promotion</option>
                <option value="EVENT">📅 Événement / Portes Ouvertes</option>
              </select>
            </div>
            <div class="field"><label>URL photo (vide = photo client)</label><input id="post-media-url" name="media_url" placeholder="https://..."></div>
            <div class="field" id="action-type-wrap">
              <label>Bouton d'action</label>
              <select name="action_type">
                <option value="BOOK">Réserver</option>
                <option value="LEARN_MORE">En savoir plus (Revue Heyzine)</option>
                <option value="CALL">Appeler</option>
                <option value="SIGN_UP">S'inscrire</option>
              </select>
            </div>
            <div class="field"><label>Lien cible (vide = page Heyzine du client)</label><input id="post-cta-url" name="cta_url" placeholder="https://..."></div>
          </div>

          <div id="event-offer-fields" class="field-grid" style="display:none;margin-top:12px;">
            <div class="field"><label>Titre de l'offre ou de l'événement *</label><input name="event_title" placeholder="Ex: Offre découverte"></div>
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
            <textarea id="post-summary" name="summary" rows="4" required placeholder="Clique sur ✨ Rédiger avec NyXia pour générer un post utile adapté au métier de ce client..."></textarea>
          </div>
          <div class="actions-stack" style="margin-top:12px;">
            <button type="button" id="btn-nyxia-draft" class="btn-sm btn-gold" style="padding:10px 16px;" onclick="draftPostWithNyxia()">✨ Rédiger avec NyXia</button>
            <button type="submit" class="btn-primary">Publier sur Google</button>
          </div>
        </form>
      </section>

      <section class="admin-card">
        <h2 class="display" style="font-size:1.75rem;color:var(--gold);margin-bottom:10px;">Optimisation Fiche Google (Lecture, Description, Horaires &amp; Recherche D1)</h2>
        <p style="color:var(--text-secondary);font-size:.86rem;margin-bottom:16px;">
          Charge toujours la fiche Google actuelle avant de modifier les horaires. Aucun horaire par défaut n'est pré-rempli afin d'éviter tout écrasement accidentel.
        </p>

        <form id="gbp-profile-form" method="POST" action="/api/google/update-profile" onsubmit="return confirmProfileUpdate(event)">
          <input type="hidden" id="profile-loaded-flag" value="0">
          <input type="hidden" id="special-hours-json" name="special_hours_json" value="[]">
          <input type="hidden" id="confirm-clear-special-hours" name="confirm_clear_special_hours" value="0">

          <div class="field-grid">
            <div class="field">
              <label>Entreprise cible (${connectedClients.length} connectée(s)) *</label>
              <select id="profile-client-select" name="client_id" required onchange="resetProfileLoadedState()">
                <option value="">-- Sélectionner le client GBP --</option>
                ${connectedOptions}
              </select>
            </div>
            <div class="field">
              <label>Points forts / spécialités à mettre de l'avant (pour NyXia)</label>
              <input id="profile-notes" placeholder="Ex: 15 ans d'expérience, soumission gratuite, urgence 24/7...">
            </div>
          </div>

          <div class="actions-stack" style="margin-top:12px;">
            <button type="button" id="btn-load-gbp" class="btn-sm btn-ghost" style="padding:10px 16px;" onclick="loadCurrentGoogleProfile()">🔄 Charger la fiche Google actuelle</button>
            <button type="button" id="btn-nyxia-profile" class="btn-sm btn-gold" style="padding:10px 16px;" onclick="draftProfileWithNyxia()">✨ Générer Description, Catégories &amp; Services avec NyXia</button>
          </div>
          <div id="profile-load-status" style="margin-top:10px;font-size:.84rem;color:var(--text-muted);"></div>

          <!-- DESCRIPTION -->
          <div style="margin-top:18px;padding-top:14px;border-top:1px solid var(--border);">
            <label class="check-row">
              <input type="checkbox" id="apply-description" name="apply_description" value="1">
              Publier la description ci-dessous sur Google
            </label>
            <div class="field" style="margin-top:8px;">
              <label>Description officielle Google (max 750 car.)</label>
              <textarea id="profile-description" name="description" rows="4" maxlength="750" placeholder="Clique sur 🔄 Charger la fiche Google actuelle ou ✨ Générer avec NyXia..."></textarea>
            </div>
          </div>

          <!-- HORAIRES RÉGULIERS JOUR PAR JOUR + FRACTIONNÉS -->
          <div style="margin-top:18px;padding-top:14px;border-top:1px solid var(--border);">
            <label class="check-row">
              <input type="checkbox" id="apply-hours" name="apply_hours" value="1">
              Publier ces horaires réguliers sur Google (vide = fermé ce jour-là)
            </label>
            <div class="table-scroll" style="margin-top:10px;">
              <table class="pd-table">
                <thead>
                  <tr>
                    <th>Jour</th>
                    <th>Plage 1 — Ouv.</th>
                    <th>Plage 1 — Ferm.</th>
                    <th>Plage 2 (fractionné) — Ouv.</th>
                    <th>Plage 2 (fractionné) — Ferm.</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>${renderHoursTableRows()}</tbody>
              </table>
            </div>
          </div>

          <!-- HORAIRES SPÉCIAUX (NOËL, CONGÉS, ÉVÉNEMENTS) -->
          <div style="margin-top:18px;padding-top:14px;border-top:1px solid var(--border);">
            <label class="check-row">
              <input type="checkbox" id="apply-special-hours" name="apply_special_hours" value="1">
              Publier ces horaires spéciaux (jours fériés, congés, événements) sur Google
            </label>
            <div id="special-hours-list" style="margin-top:10px;display:flex;flex-direction:column;gap:8px;"></div>
            <button type="button" class="btn-sm btn-ghost" style="margin-top:10px;" onclick="addSpecialHourRow()">+ Ajouter une date spéciale</button>
          </div>

          <!-- DONNÉES RECHERCHE PUBLIQUE D1 + AIDE NYXIA -->
          <div class="field-grid" style="margin-top:18px;padding-top:14px;border-top:1px solid var(--border);">
            <div class="field">
              <label>Services précis (enregistré dans D1 pour la recherche publique)</label>
              <textarea id="profile-services" name="services_d1" rows="3" placeholder="Ex: coloration, mèches, coupe pour homme, coiffure de mariage..."></textarea>
              <button type="button" class="btn-sm btn-ghost" style="margin-top:6px;" onclick="copyTextField('profile-services', this)">📋 Copier les services</button>
            </div>
            <div class="field">
              <label>Territoire desservi (enregistré dans D1 pour la recherche publique)</label>
              <textarea id="profile-service-areas" name="service_areas_d1" rows="3" placeholder="Ex: Saint-Calixte, Sainte-Julienne, Rawdon, Lanaudière..."></textarea>
            </div>
            <div class="field">
              <label>Catégories recommandées par NyXia (prêt à copier dans Google)</label>
              <textarea id="profile-categories" rows="3" placeholder="Catégorie principale et secondaires..."></textarea>
              <button type="button" class="btn-sm btn-ghost" style="margin-top:6px;" onclick="copyTextField('profile-categories', this)">📋 Copier les catégories</button>
            </div>
          </div>

          <div style="margin-top:18px;">
            <button type="submit" class="btn-primary">Valider, Publier sur Google &amp; Synchroniser D1</button>
          </div>
        </form>
      </section>

      <section class="admin-card">
        <h2 class="display" style="font-size:1.75rem;color:#fff;margin-bottom:14px;">Avis Google Clients &amp; Réponses IA en 1 clic</h2>
        <div class="table-scroll">
          <table class="pd-table">
            <thead><tr><th>Entreprise &amp; Note</th><th>Commentaire</th><th>Réponse publique</th></tr></thead>
            <tbody>${reviewsRows || '<tr><td colspan="3" style="color:var(--text-muted);text-align:center;padding:18px;">Aucun avis synchronisé. Clique sur « ↻ Sync Avis » dans l’onglet Entrepreneurs.</td></tr>'}</tbody>
          </table>
        </div>
      </section>
    </div>

    ${renderMagazinePanel(magazineIssues)}

    <!-- ONGLET 4 : TESTS SMS & SÉCURITÉ -->
    <div id="panel-settings" class="tab-panel">
      <section class="admin-card">
        <h2 class="display" style="font-size:1.75rem;color:var(--gold);margin-bottom:14px;">Test Alerte SMS Appointment Setter</h2>
        <form method="POST" action="/api/test-nyxia-sms">
          <div class="field-grid">
            <div class="field"><label>Simuler un lead pour le client *</label><select name="client_id" required>${allClientOptions}</select></div>
            <div class="field"><label>Nom du prospect test</label><input name="prospect_name" value="Sophie Gagnon" required></div>
            <div class="field"><label>Contact prospect</label><input name="prospect_contact" value="450-555-0142" required></div>
            <div class="field"><label>Message du prospect</label><input name="prospect_message" value="Intéressée par vos services suite à la revue Heyzine !" required></div>
          </div>
          <div style="margin-top:12px;">
            <button type="submit" class="btn-sm btn-gold" style="padding:10px 18px;">📱 Envoyer un SMS de test vers ton cellulaire</button>
          </div>
        </form>
      </section>

      <section class="admin-card">
        <h2 class="display" style="font-size:1.5rem;color:#fff;margin-bottom:10px;">Sécurité • Mot de passe Associé / Équipe</h2>
        <p style="color:var(--text-secondary);font-size:.88rem;margin-bottom:14px;">Définis un second mot de passe chiffré dans D1 pour ton associé ou tes setters sans partager ton mot de passe maître Cloudflare.</p>
        <form method="POST" action="/api/change-password" style="display:flex;gap:12px;flex-wrap:wrap;max-width:680px;">
          <div class="field" style="flex:1;min-width:200px;"><input type="password" name="new_password" placeholder="Nouveau mot de passe (min. 8 car.)" required></div>
          <div class="field" style="flex:1;min-width:200px;"><input type="password" name="confirm_password" placeholder="Confirmer le mot de passe" required></div>
          <button type="submit" class="btn-ghost">Enregistrer</button>
        </form>
      </section>
    </div>
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
          <div class="field"><label>Ville principale *</label><input name="city" id="edit-city" required></div>
          <div class="field"><label>Catégorie principale *</label><input name="category" id="edit-category" required></div>
          <div class="field"><label>Services précis (recherche)</label><input name="services" id="edit-services"></div>
          <div class="field"><label>Territoire desservi</label><input name="service_areas" id="edit-service_areas"></div>
          <div class="field"><label>Téléphone</label><input name="phone" id="edit-phone"></div>
          <div class="field"><label>Courriel vendeur (invitations RDV)</label><input type="email" name="client_email" id="edit-client_email"></div>
          <div class="field"><label>Lien Agenda Google Workspace</label><input type="url" name="booking_calendar_url" id="edit-booking_calendar_url"></div>
          <div class="field"><label>Numero SMS Twilio reserve a l'entreprise (+1...)</label><input name="twilio_sms_number" id="edit-twilio_sms_number"></div>
          <div class="field"><label>Telephone alertes Setter (optionnel)</label><input name="setter_alert_phone" id="edit-setter_alert_phone"></div>
          <div class="field"><label>Lien avis Google</label><input type="url" name="google_review_url" id="edit-google_review_url"></div>
          <div class="field"><label>URL Page Heyzine (#page/X)</label><input type="url" name="heyzine_url" id="edit-heyzine_url"></div>
          <div class="field"><label>URL Vidéo entrevue</label><input type="url" name="interview_video_url" id="edit-interview_video_url"></div>
          <div class="field"><label>URL Photo couverture principale</label><input type="url" name="cover_photo_url" id="edit-cover_photo_url"></div>
        </div>
        <div class="field" style="margin-top:12px;"><label>Adresse de l’établissement</label><input name="public_address" id="edit-public_address"></div>
        <label class="check-row"><input type="checkbox" name="show_public_address" id="edit-show_public_address" value="1"> Autoriser l’affichage de l’adresse sur le répertoire public</label>
        <div class="field-grid" style="margin-top:12px;">
          <div class="field"><label>Site web</label><input type="url" name="social_website" id="edit-social_website"></div>
          <div class="field"><label>Facebook</label><input type="url" name="social_facebook" id="edit-social_facebook"></div>
          <div class="field"><label>Instagram</label><input type="url" name="social_instagram" id="edit-social_instagram"></div>
          <div class="field"><label>LinkedIn</label><input type="url" name="social_linkedin" id="edit-social_linkedin"></div>
          <div class="field"><label>TikTok</label><input type="url" name="social_tiktok" id="edit-social_tiktok"></div>
          <div class="field"><label>YouTube</label><input type="url" name="social_youtube" id="edit-social_youtube"></div>
        </div>
        <div class="field" style="margin-top:12px;"><label>Texte narratif du publireportage</label><textarea name="advertorial_text" id="edit-advertorial_text" rows="3"></textarea></div>
        <div class="field" style="margin-top:12px;"><label>Consignes Setters</label><input name="booking_notes" id="edit-booking_notes"></div>
        <div class="field" style="margin-top:12px;"><label>Photos galerie (max 5 URLs séparées par virgule)</label><input name="gallery_urls" id="edit-gallery_urls"></div>
        <div style="margin-top:18px;display:flex;justify-content:flex-end;gap:10px;">
          <button type="button" class="btn-ghost" onclick="closeEditModal()">Annuler</button>
          <button type="submit" class="btn-primary">Sauvegarder les modifications</button>
        </div>
      </form>
    </div>
  </div>

  <script src="${ADMIN_JS_URL}" defer></script>
</body>
</html>`;
}
