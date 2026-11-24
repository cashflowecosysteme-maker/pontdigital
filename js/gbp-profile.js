// ============================================================================
// PONT DIGITAL — MODULE OPTIMISATION FICHE GBP (DESCRIPTION, HORAIRES, SERVICES)
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
      services: `• Consultation & évaluation en ${client.category}\n• Accompagnement personnalisé à ${client.city}\n• Suivi et conseils professionnels`
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
              '3. "services" : Liste de 5 à 7 services clairs et vendeurs (1 par ligne avec un court bénéfice) adaptés au métier.'
          },
          {
            role: 'user',
            content:
              `Entreprise : ${client.business_name}\n` +
              `Ville : ${client.city}\n` +
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

export async function handleUpdateGoogleProfileRoute(request, env, getGoogleAccessToken, listAllGoogleLocations) {
  const formData = await request.formData();
  const clientId = formData.get('client_id');
  const description = (formData.get('description') || '').trim().slice(0, 750);
  const applyHours = formData.get('apply_hours') === '1';

  if (!clientId || (!description && !applyHours)) {
    return Response.redirect(new URL('/?msg=error_fields', request.url), 302);
  }

  const client = await env.DB.prepare('SELECT * FROM clients WHERE id = ?').bind(clientId).first();
  if (!client || !client.google_refresh_token) {
    return Response.redirect(new URL('/?msg=google_not_connected', request.url), 302);
  }

  try {
    const accessToken = await getGoogleAccessToken(client.google_refresh_token, env);
    let locationName = client.google_location_name;

    if (!locationName) {
      const allLocs = await listAllGoogleLocations(accessToken);
      if (allLocs.length > 0) locationName = allLocs[0].locationName;
    }
    if (!locationName) return Response.redirect(new URL('/?msg=google_api_error', request.url), 302);

    // L'API Business Information v1 attend "locations/{id}" sans préfixe "accounts/..."
    const v1Location = locationName.includes('locations/')
      ? 'locations/' + locationName.split('locations/').pop()
      : locationName;

    const updateMask = [];
    const payload = {};

    if (description) {
      updateMask.push('profile.description');
      payload.profile = { description };
    }

    if (applyHours) {
      const periods = buildRegularHoursPeriods(formData);
      if (periods.length > 0) {
        updateMask.push('regularHours');
        payload.regularHours = { periods };
      }
    }

    if (updateMask.length === 0) {
      return Response.redirect(new URL('/?msg=error_fields', request.url), 302);
    }

    const patchRes = await fetch(
      `[https://mybusinessbusinessinformation.googleapis.com/v1/$](https://mybusinessbusinessinformation.googleapis.com/v1/$){v1Location}?updateMask=${encodeURIComponent(updateMask.join(','))}`,
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

    return Response.redirect(new URL('/?msg=profile_updated', request.url), 302);
  } catch (_) {
    return Response.redirect(new URL('/?msg=google_api_error', request.url), 302);
  }
}

function parseTimeParts(hhmm) {
  const [h, m] = String(hhmm || '').split(':').map(n => parseInt(n, 10));
  if (isNaN(h) || isNaN(m)) return null;
  return { hours: h, minutes: m };
}

function buildRegularHoursPeriods(formData) {
  const periods = [];
  const weekOpen = parseTimeParts(formData.get('week_open'));
  const weekClose = parseTimeParts(formData.get('week_close'));
  if (weekOpen && weekClose) {
    ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'].forEach(day => {
      periods.push({ openDay: day, openTime: weekOpen, closeDay: day, closeTime: weekClose });
    });
  }

  const satOpen = parseTimeParts(formData.get('sat_open'));
  const satClose = parseTimeParts(formData.get('sat_close'));
  if (satOpen && satClose) {
    periods.push({ openDay: 'SATURDAY', openTime: satOpen, closeDay: 'SATURDAY', closeTime: satClose });
  }

  const sunOpen = parseTimeParts(formData.get('sun_open'));
  const sunClose = parseTimeParts(formData.get('sun_close'));
  if (sunOpen && sunClose) {
    periods.push({ openDay: 'SUNDAY', openTime: sunOpen, closeDay: 'SUNDAY', closeTime: sunClose });
  }
  return periods;
}
