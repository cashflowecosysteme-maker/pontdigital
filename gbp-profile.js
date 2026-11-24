// ============================================================================
// PONT DIGITAL — MODULE OPTIMISATION FICHE GBP
// Fonctions : Lecture Google (GET), Rédaction NyXia, Mise à jour sécurisée
//             (Description, Horaires jour par jour + fractionnés + après minuit,
//             Horaires spéciaux), Vérification réelle post-envoi et Synchro D1.
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

function getNextDay(dayCode) {
  const idx = DAYS_ORDER.indexOf(dayCode);
  if (idx === -1) return dayCode;
  return DAYS_ORDER[(idx + 1) % DAYS_ORDER.length];
}

function getNextDateParts(dateParts) {
  const d = new Date(Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day + 1));
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate()
  };
}

function timeToMinutes(t) {
  if (!t || typeof t !== 'object') return -1;
  return Number(t.hours || 0) * 60 + Number(t.minutes || 0);
}

function isOvernight(openTime, closeTime) {
  return timeToMinutes(closeTime) <= timeToMinutes(openTime);
}

function formatStorefrontAddress(addr) {
  if (!addr || typeof addr !== 'object') return '';
  const lines = Array.isArray(addr.addressLines) ? addr.addressLines.filter(Boolean) : [];
  const cityProv = [addr.locality, addr.administrativeArea, addr.postalCode].filter(Boolean).join(', ');
  return [...lines, cityProv].filter(Boolean).join(', ');
}

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
      periods.push({
        openDay: day,
        openTime: open1,
        closeDay: isOvernight(open1, close1) ? getNextDay(day) : day,
        closeTime: close1
      });
    }
    const open2 = parseTimeParts(formData.get(`day_${day}_open2`));
    const close2 = parseTimeParts(formData.get(`day_${day}_close2`));
    if (open2 && close2) {
      periods.push({
        openDay: day,
        openTime: open2,
        closeDay: isOvernight(open2, close2) ? getNextDay(day) : day,
        closeTime: close2
      });
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
          endDate: isOvernight(openTime, closeTime) ? getNextDateParts(dateParts) : dateParts,
          closeTime,
          closed: false
        });
      }
    }
  }
  return periods;
}

// ============================================================================
// COMPARAISON RÉELLE POST-PUBLICATION (DEMANDÉ VS RELU SUR GOOGLE)
// ============================================================================

function normalizeRegularSignature(periods) {
  return (periods || [])
    .map(p => `${p.openDay}|${formatGoogleTime(p.openTime)}|${p.closeDay}|${formatGoogleTime(p.closeTime)}`)
    .sort()
    .join(';');
}

function normalizeSpecialSignature(periods) {
  return (periods || [])
    .map(p => {
      const start = formatGoogleDate(p.startDate);
      const end = formatGoogleDate(p.endDate || p.startDate);
      if (p.closed) return `${start}|${end}|CLOSED`;
      return `${start}|${end}|${formatGoogleTime(p.openTime)}|${formatGoogleTime(p.closeTime)}`;
    })
    .sort()
    .join(';');
}

function verifyAppliedChanges(verifiedData, requested) {
  if (!verifiedData || typeof verifiedData !== 'object') return false;

  if (requested.applyDescription) {
    const actualDesc = String(verifiedData?.profile?.description || '').trim();
    if (actualDesc !== String(requested.description || '').trim()) {
      return false;
    }
  }

  if (requested.applyHours) {
    const expectedSig = normalizeRegularSignature(requested.regularPeriods);
    const actualSig = normalizeRegularSignature(verifiedData?.regularHours?.periods || []);
    if (expectedSig !== actualSig) {
      return false;
    }
  }

  if (requested.applySpecialHours) {
    const expectedSig = normalizeSpecialSignature(requested.specialPeriods);
    const actualSig = normalizeSpecialSignature(verifiedData?.specialHours?.specialHourPeriods || []);
    if (expectedSig !== actualSig) {
      return false;
    }
  }

  return true;
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
      `https://mybusinessbusinessinformation.googleapis.com/v1/${v1Location}?readMask=title,profile,regularHours,specialHours,storefrontAddress`,
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
    const googleAddress = formatStorefrontAddress(locData?.storefrontAddress);
    const syncedHoursPayload = JSON.stringify({
      regularHours: locData?.regularHours || null,
      specialHours: locData?.specialHours || null,
      synced_at: new Date().toISOString()
    });

    await env.DB.prepare(`
      UPDATE clients
      SET gbp_description = ?,
          gbp_hours_json = ?,
          public_address = COALESCE(NULLIF(public_address, ''), ?)
      WHERE id = ?
    `).bind(description, syncedHoursPayload, googleAddress || null, client.id).run();

    return jsonResponse({
      ok: true,
      client_id: String(client.id),
      location_title: locData?.title || client.google_location_title || client.business_name,
      location_name: v1Location,
      description,
      public_address: client.public_address || googleAddress || '',
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
// 3. MISE À JOUR GOOGLE + VÉRIFICATION RÉELLE POST-ENVOI + SYNCHRO D1
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
  let regularPeriods = [];
  let specialPeriods = [];

  if (applyDescription && description) {
    updateMask.push('profile.description');
    payload.profile = { description };
  }

  if (applyHours) {
    regularPeriods = buildRegularHoursPeriodsFromForm(formData);
    // PROTECTION : refuser d'envoyer une liste d'horaires réguliers entièrement vide
    if (regularPeriods.length === 0) {
      return Response.redirect(new URL('/?msg=hours_empty_blocked', request.url), 302);
    }
    updateMask.push('regularHours');
    payload.regularHours = { periods: regularPeriods };
  }

  if (applySpecialHours) {
    specialPeriods = buildSpecialHourPeriodsFromJson(formData.get('special_hours_json'));
    updateMask.push('specialHours');
    payload.specialHours = { specialHourPeriods: specialPeriods };
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

    // VÉRIFICATION RÉELLE APRÈS PUBLICATION : relecture + comparaison stricte des valeurs
    const verifyRes = await fetch(
      `https://mybusinessbusinessinformation.googleapis.com/v1/${v1Location}?readMask=profile,regularHours,specialHours`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}` }
      }
    );

    let verifiedDesc = client.gbp_description || '';
    let verifiedHoursJson = client.gbp_hours_json || null;
    let statusMsg = 'profile_updated';

    if (verifyRes.ok) {
      const verifiedData = await verifyRes.json();
      if (verifiedData?.profile?.description !== undefined) {
        verifiedDesc = verifiedData.profile.description;
      }
      verifiedHoursJson = JSON.stringify({
        regularHours: verifiedData?.regularHours || null,
        specialHours: verifiedData?.specialHours || null,
        synced_at: new Date().toISOString()
      });

      const exactMatch = verifyAppliedChanges(verifiedData, {
        applyDescription: applyDescription && Boolean(description),
        description,
        applyHours,
        regularPeriods,
        applySpecialHours,
        specialPeriods
      });

      statusMsg = exactMatch ? 'profile_updated_verified' : 'profile_updated_pending';
    }

    // Synchronisation D1 avec les valeurs réellement relues sur Google
    await env.DB.prepare(`
      UPDATE clients
      SET gbp_description = ?, gbp_hours_json = ?
      WHERE id = ?
    `).bind(verifiedDesc, verifiedHoursJson, client.id).run();

    return Response.redirect(new URL(`/?msg=${statusMsg}`, request.url), 302);
  } catch (_) {
    return Response.redirect(new URL('/?msg=google_api_error', request.url), 302);
  }
}
