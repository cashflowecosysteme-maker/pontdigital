// ============================================================================
// PONT DIGITAL — MODULE OPTIMISATION FICHE GBP
// Fonctions : Lecture Google (GET), Rédaction NyXia, Mise à jour sécurisée
//             (Description, Horaires jour par jour + fractionnés, Horaires spéciaux),
//             Vérification post-envoi et Synchronisation D1.
// Sécurité multi-fiches : aucune lecture/écriture sans google_location_name.
// ============================================================================

const DAYS_ORDER = [
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
  'SUNDAY'
];

function extractV1Location(locationName) {
  const clean = String(locationName || '').trim();
  if (!clean) return null;
  if (clean.includes('locations/')) {
    return 'locations/' + clean.split('locations/').pop();
  }
  return clean;
}

function formatGoogleTime(timeObj) {
  if (!timeObj || typeof timeObj !== 'object') return '';
  const h = Number(timeObj.hours ?? 0);
  const m = Number(timeObj.minutes ?? 0);
  if (Number.isNaN(h) || Number.isNaN(m)) return '';
  if (h === 24 && m === 0) return '23:59';
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function parseTimeParts(hhmm) {
  const raw = String(hhmm || '').trim();
  if (!raw || !raw.includes(':')) return null;
  const [h, m] = raw.split(':').map(n => parseInt(n, 10));
  if (Number.isNaN(h) || Number.isNaN(m) || h < 0 || h > 23 || m < 0 || m > 59) return null;
  return { hours: h, minutes: m };
}

function formatGoogleDate(dateObj) {
  if (!dateObj || !dateObj.year || !dateObj.month || !dateObj.day) return '';
  return `${String(dateObj.year).padStart(4, '0')}-${String(dateObj.month).padStart(2, '0')}-${String(dateObj.day).padStart(2, '0')}`;
}

function parseDateParts(yyyyMmDd) {
  const m = String(yyyyMmDd || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return {
    year: parseInt(m[1], 10),
    month: parseInt(m[2], 10),
    day: parseInt(m[3], 10)
  };
}

function mapRegularHoursToGrid(regularHours) {
  const grid = {};
  for (const day of DAYS_ORDER) {
    grid[day] = { open1: '', close1: '', open2: '', close2: '' };
  }
  const periods = regularHours?.periods || [];
  for (const p of periods) {
    const day = p.openDay;
    if (!grid[day]) continue;
    const openStr = formatGoogleTime(p.openTime);
    const closeStr = formatGoogleTime(p.closeTime);
    if (!openStr || !closeStr) continue;
    if (!grid[day].open1) {
      grid[day].open1 = openStr;
      grid[day].close1 = closeStr;
    } else if (!grid[day].open2) {
      grid[day].open2 = openStr;
      grid[day].close2 = closeStr;
    }
  }
  return grid;
}

function mapSpecialHoursToList(specialHours) {
  const list = [];
  const periods = specialHours?.specialHourPeriods || [];
  for (const p of periods) {
    const date = formatGoogleDate(p.startDate);
    if (!date) continue;
    list.push({
      date,
      closed: Boolean(p.closed),
      open: p.closed ? '' : formatGoogleTime(p.openTime),
      close: p.closed ? '' : formatGoogleTime(p.closeTime)
    });
  }
  return list;
}

function buildRegularHoursPeriodsFromForm(formData) {
  const periods = [];
  for (const day of DAYS_ORDER) {
    const open1 = parseTimeParts(formData.get(`day_${day}_open1`));
    const close1 = parseTimeParts(formData.get(`day_${day}_close1`));
    if (open1 && close1) {
      periods.push({ openDay: day, openTime: open1, closeDay: day, closeTime: close1 });
    }
    const open2 = parseTimeParts(formData.get(`day_${day}_open2`));
    const close2 = parseTimeParts(formData.get(`day_${day}_close2`));
    if (open2 && close2) {
      periods.push({ openDay: day, openTime: open2, closeDay: day, closeTime: close2 });
    }
  }
  return periods;
}

function buildSpecialHourPeriodsFromJson(rawJson) {
  let items = [];
  try {
    items = JSON.parse(rawJson || '[]');
  } catch (_) {
    return [];
  }
  if (!Array.isArray(items)) return [];

  const periods = [];
  for (const item of items) {
    const dateParts = parseDateParts(item?.date);
    if (!dateParts) continue;
    if (item.closed) {
      periods.push({
        startDate: dateParts,
        endDate: dateParts,
        closed: true
      });
    } else {
      const openTime = parseTimeParts(item.open);
      const closeTime = parseTimeParts(item.close);
      if (openTime && closeTime) {
        periods.push({
          startDate: dateParts,
          openTime,
          endDate: dateParts,
          closeTime,
          closed: false
        });
      }
    }
  }
  return periods;
}

// ============================================================================
// 1. LECTURE DE LA FICHE GOOGLE ACTUELLE (DESCRIPTION + HORAIRES + SPÉCIAUX)
// ============================================================================

export async function handleReadGoogleProfileApi(request, env, getGoogleAccessToken, jsonResponse) {
  try {
    const url = new URL(request.url);
    const clientId = url.searchParams.get('client_id');
    if (!clientId) return jsonResponse({ error: 'Sélectionne d’abord un entrepreneur.' }, 400);

    const client = await env.DB.prepare('SELECT * FROM clients WHERE id = ?').bind(clientId).first();
    if (!client || !client.google_refresh_token) {
      return jsonResponse({ error: 'Ce client n’est pas encore connecté à Google Business Profile.' }, 400);
    }

    const v1Location = extractV1Location(client.google_location_name);
    if (!v1Location) {
      return jsonResponse({
        error: 'Sécurité multi-fiches : associe d’abord la fiche Google précise de ce client (« Changer fiche ») avant de la lire.'
      }, 400);
    }

    const accessToken = await getGoogleAccessToken(client.google_refresh_token, env);
    const readRes = await fetch(
      `https://mybusinessbusinessinformation.googleapis.com/v1/${v1Location}?readMask=title,profile,regularHours,specialHours`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}` }
      }
    );

    const locData = await readRes.json();
    if (!readRes.ok) {
      return jsonResponse({
        error: locData?.error?.message || 'Impossible de lire cette fiche depuis Google Business Profile.'
      }, 502);
    }

    const description = locData?.profile?.description || '';
    const hoursGrid = mapRegularHoursToGrid(locData?.regularHours);
    const specialHours = mapSpecialHoursToList(locData?.specialHours);
    const syncedHoursPayload = JSON.stringify({
      regularHours: locData?.regularHours || null,
      specialHours: locData?.specialHours || null,
      synced_at: new Date().toISOString()
    });

    // Synchronisation automatique dans D1 pour le futur site public
    await env.DB.prepare(`
      UPDATE clients
      SET gbp_description = ?, gbp_hours_json = ?
      WHERE id = ?
    `).bind(description, syncedHoursPayload, client.id).run();

    return jsonResponse({
      ok: true,
      location_title: locData?.title || client.google_location_title || client.business_name,
      location_name: v1Location,
      description,
      hours_grid: hoursGrid,
      special_hours: specialHours,
      services: client.services || '',
      service_areas: client.service_areas || ''
    });
  } catch (_) {
    return jsonResponse({ error: 'Erreur technique lors de la lecture de la fiche Google.' }, 500);
  }
}

// ============================================================================
// 2. RÉDACTION IA NYXIA (DESCRIPTION, CATÉGORIES & SERVICES)
// ============================================================================

export async function handleNyxiaDraftProfileApi(request, env, jsonResponse) {
  try {
    const body = await request.json();
    const clientId = body.client_id;
    const notes = String(body.notes || '').trim();

    if (!clientId) return jsonResponse({ error: 'Sélectionne d’abord un entrepreneur.' }, 400);
    const client = await env.DB.prepare('SELECT * FROM clients WHERE id = ?').bind(clientId).first();
    if (!client) return jsonResponse({ error: 'Client introuvable.' }, 404);

    const fallback = {
      description: `${client.business_name} accompagne les clients de ${client.city} en ${client.category} avec une approche humaine, rigoureuse et transparente. Contactez notre équipe pour un service professionnel adapté à vos besoins.`,
      categories: `${client.category} (principale), Service de proximité, Consultation spécialisée`,
      services: `Consultation en ${client.category}, Accompagnement personnalisé à ${client.city}, Suivi professionnel`
    };

    if (!env.OPENROUTER_API_KEY) return jsonResponse(fallback);

    const model = env.OPENROUTER_MODEL || 'google/gemini-2.5-flash';
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://SuperAdmin-Pontdigital.nyxia.top',
        'X-Title': 'Pont Digital - NyXia GBP Optimizer'
      },
      body: JSON.stringify({
        model,
        temperature: 0.55,
        max_tokens: 650,
        messages: [
          {
            role: 'system',
            content:
              "Tu es NyXia, stratège SEO local et GEO (IA) pour Pont Digital au Québec.\n" +
              "Réponds UNIQUEMENT avec un objet JSON valide (sans texte avant ni après) contenant exactement 3 clés :\n" +
              '1. "description" : Description officielle Google Business Profile en français québécois professionnel, optimisée SEO/GEO, 550 à 720 caractères MAXIMUM (limite Google : 750), zéro hashtag, zéro URL, zéro majuscule abusive.\n' +
              '2. "categories" : 1 catégorie Google principale + 2 à 4 catégories secondaires pertinentes séparées par des virgules.\n' +
              '3. "services" : Liste de 5 à 8 prestations précises séparées par des virgules (ex: coloration, mèches, coupe homme, coiffure de mariage) adaptées au métier et directement exploitables dans un moteur de recherche.'
          },
          {
            role: 'user',
            content:
              `Entreprise : ${client.business_name}\n` +
              `Ville : ${client.city}\n` +
              `Territoire desservi : ${client.service_areas || client.city}\n` +
              `Métier : ${client.category}\n` +
              `Précisions / points forts : ${notes || 'Service local fiable et professionnel au Québec.'}`
          }
        ]
      })
    });

    const data = await res.json();
    const raw = (data.choices?.[0]?.message?.content || '').trim();
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();

    try {
      const parsed = JSON.parse(cleaned);
      return jsonResponse({
        description: String(parsed.description || fallback.description).slice(0, 750),
        categories: String(parsed.categories || fallback.categories),
        services: String(parsed.services || fallback.services)
      });
    } catch (_) {
      return jsonResponse({ ...fallback, description: cleaned.slice(0, 750) || fallback.description });
    }
  } catch (_) {
    return jsonResponse({ error: 'Erreur lors de la génération par NyXia.' }, 500);
  }
}

// ============================================================================
// 3. MISE À JOUR GOOGLE + VÉRIFICATION POST-ENVOI + SYNCHRO D1
// ============================================================================

export async function handleUpdateGoogleProfileRoute(request, env, getGoogleAccessToken) {
  const formData = await request.formData();
  const clientId = formData.get('client_id');
  const applyDescription = formData.get('apply_description') === '1';
  const applyHours = formData.get('apply_hours') === '1';
  const applySpecialHours = formData.get('apply_special_hours') === '1';
  const description = (formData.get('description') || '').trim().slice(0, 750);
  const services = (formData.get('services_d1') || '').trim();
  const serviceAreas = (formData.get('service_areas_d1') || '').trim();

  if (!clientId) {
    return Response.redirect(new URL('/?msg=error_fields', request.url), 302);
  }

  const client = await env.DB.prepare('SELECT * FROM clients WHERE id = ?').bind(clientId).first();
  if (!client || !client.google_refresh_token) {
    return Response.redirect(new URL('/?msg=google_not_connected', request.url), 302);
  }

  // SÉCURITÉ MULTI-FICHES : aucune modification sans établissement explicitement associé au client
  const v1Location = extractV1Location(client.google_location_name);
  if (!v1Location) {
    return Response.redirect(new URL('/?msg=google_location_required', request.url), 302);
  }

  // Sauvegarde des champs de recherche publique (services & territoire) dans D1 si renseignés
  if (services || serviceAreas) {
    await env.DB.prepare(`
      UPDATE clients
      SET services = CASE WHEN ? != '' THEN ? ELSE services END,
          service_areas = CASE WHEN ? != '' THEN ? ELSE service_areas END
      WHERE id = ?
    `).bind(services, services, serviceAreas, serviceAreas, client.id).run();
  }

  const updateMask = [];
  const payload = {};

  if (applyDescription && description) {
    updateMask.push('profile.description');
    payload.profile = { description };
  }

  if (applyHours) {
    const periods = buildRegularHoursPeriodsFromForm(formData);
    updateMask.push('regularHours');
    payload.regularHours = { periods };
  }

  if (applySpecialHours) {
    const specialHourPeriods = buildSpecialHourPeriodsFromJson(formData.get('special_hours_json'));
    updateMask.push('specialHours');
    payload.specialHours = { specialHourPeriods };
  }

  if (updateMask.length === 0) {
    if (services || serviceAreas) {
      return Response.redirect(new URL('/?msg=profile_d1_only', request.url), 302);
    }
    return Response.redirect(new URL('/?msg=error_fields', request.url), 302);
  }

  try {
    const accessToken = await getGoogleAccessToken(client.google_refresh_token, env);

    const patchRes = await fetch(
      `https://mybusinessbusinessinformation.googleapis.com/v1/${v1Location}?updateMask=${encodeURIComponent(updateMask.join(','))}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      }
    );

    if (!patchRes.ok) {
      return Response.redirect(new URL('/?msg=google_api_error', request.url), 302);
    }

    // VÉRIFICATION APRÈS PUBLICATION : relecture officielle depuis Google pour confirmer l'acceptation
    const verifyRes = await fetch(
      `https://mybusinessbusinessinformation.googleapis.com/v1/${v1Location}?readMask=profile,regularHours,specialHours`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}` }
      }
    );

    let verifiedDesc = applyDescription ? description : (client.gbp_description || '');
    let verifiedHoursJson = client.gbp_hours_json || null;
    let verifiedOk = false;

    if (verifyRes.ok) {
      const verifiedData = await verifyRes.json();
      verifiedOk = true;
      if (verifiedData?.profile?.description !== undefined) {
        verifiedDesc = verifiedData.profile.description;
      }
      verifiedHoursJson = JSON.stringify({
        regularHours: verifiedData?.regularHours || null,
        specialHours: verifiedData?.specialHours || null,
        synced_at: new Date().toISOString()
      });
    }

    // Synchronisation D1 immédiate avec les données confirmées par Google
    await env.DB.prepare(`
      UPDATE clients
      SET gbp_description = ?, gbp_hours_json = ?
      WHERE id = ?
    `).bind(verifiedDesc, verifiedHoursJson, client.id).run();

    return Response.redirect(
      new URL(verifiedOk ? '/?msg=profile_updated_verified' : '/?msg=profile_updated', request.url),
      302
    );
  } catch (_) {
    return Response.redirect(new URL('/?msg=google_api_error', request.url), 302);
  }
}
