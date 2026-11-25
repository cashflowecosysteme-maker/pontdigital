// PONT DIGITAL — Recherche en D1 et revue Heyzine (aucune donnée inventée)
(function () {
  'use strict';
  var allClients=[], filtered=[], visible=12, issues=[];
  var $=id=>document.getElementById(id);
  var safe=(s)=>{try{var u=new URL(String(s||''));return (u.protocol==='https:'||u.protocol==='http:')?u.href:'';}catch{return '';}};
  var esc=(s)=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  var norm=(s)=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase('fr-CA').replace(/[^a-z0-9]+/g,' ').trim();
  var perPage=12;
  var formatter=new Intl.DateTimeFormat('fr-CA',{month:'long',year:'numeric',timeZone:'America/Toronto'});
  function prettyMonth(ym){var p=String(ym||'').match(/^(\d{4})-(\d{2})$/);if(!p)return ym;return formatter.format(new Date(Date.UTC(Number(p[1]),Number(p[2])-1,10,12)));}

  function displayIssue(issue){
    var host=$('magazine-stage'), label=$('current-edition-label'), desc=$('magazine-description'), open=$('magazine-open');
    if(!host)return;
    label.textContent=prettyMonth(issue.issue_month);
    desc.textContent=issue.introduction||issue.title;
    var url=safe(issue.heyzine_url);
    if(!url)return;
    // Le contenu Heyzine est servi directement par son fournisseur, sans duplicata.
    host.replaceChildren();
    var frame=document.createElement('iframe');frame.title='Revue Pont Digital — '+issue.title;frame.loading='lazy';frame.referrerPolicy='strict-origin-when-cross-origin';frame.allowFullscreen=true;frame.src=url;
    host.appendChild(frame);
    open.hidden=false;open.href=url;
    document.querySelectorAll('#archive-list button').forEach(b=>b.setAttribute('aria-current',b.dataset.month===issue.issue_month?'true':'false'));
  }
  async function loadIssues(){
    try{
      var res=await fetch('/api/public/magazines');if(!res.ok)throw Error('indisponible');
      var data=await res.json();issues=Array.isArray(data.issues)?data.issues.filter(i=>safe(i.heyzine_url)):[];
      if(!issues.length)return;
      var list=$('archive-list');list.replaceChildren();
      issues.forEach(issue=>{var b=document.createElement('button');b.type='button';b.dataset.month=issue.issue_month;b.textContent=prettyMonth(issue.issue_month);b.addEventListener('click',()=>{displayIssue(issue);document.getElementById('revue').scrollIntoView({behavior:'smooth'});});list.appendChild(b);});
      if(issues.length>1)$('archives').hidden=false;
      displayIssue(issues[0]);
    }catch(e){$('magazine-description').textContent='La revue du mois sera affichée ici dès sa publication.';}
  }
  async function loadCities(){
    try{
      var res=await fetch('/api/public/municipalities');if(!res.ok)throw Error('source');
      var data=await res.json();var arr=Array.isArray(data.cities)?data.cities:[];
      var d=$('city-options'), f=document.createDocumentFragment();
      arr.forEach(v=>{var o=document.createElement('option');o.value=v;f.appendChild(o);});d.replaceChildren(f);
      $('city-source-status').textContent=data.complete?'Municipalités du Québec · Source : MAMH / Données Québec':'Suggestions limitées aux villes des entreprises inscrites (référentiel provincial indisponible).';
    }catch(e){$('city-source-status').textContent='Vous pouvez saisir librement une ville du Québec.';}
  }
  function fillCategory(){
    var cats=[...new Set(allClients.map(c=>String(c.category||'').trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'fr-CA'));
    var select=$('filter-category');cats.forEach(s=>{var o=document.createElement('option');o.value=s;o.textContent=s;select.appendChild(o);});
  }
  function card(c){
    var name=esc(c.business_name),city=esc(c.city),cat=esc(c.category);
    var image=safe(c.cover_photo_url);
    var desc=esc(c.advertorial_text||c.description||c.services||'Découvrez cette entreprise du Québec, ses services et ses réalisations.');
    var detail='/entreprise/'+encodeURIComponent(c.id);
    var google=safe(c.google_url);
    return `<article class="directory-card"><div class="card-cover">${image?`<img loading="lazy" src="${esc(image)}" alt="${name}">`:'<span class="card-cover-empty">PONT DIGITAL</span>'}</div><div class="card-inner"><p class="card-category">${cat} · ${city}</p><h3>${name}</h3>${c.google_rating!==null&&c.google_rating!==undefined?`<span class="card-rating">★ ${Number(c.google_rating).toFixed(1)} ${c.google_review_count!=null?'('+Number(c.google_review_count)+' avis)':''} · Google</span>`:''}<p class="card-desc">${desc}</p><div class="card-foot"><a class="btn-gold" href="${detail}">Découvrir l'entreprise</a>${google?`<a class="btn-ghost" href="${esc(google)}" target="_blank" rel="noopener noreferrer">${c.google_place_id?'Fiche Google ↗':'Rechercher sur Google ↗'}</a>`:''}${safe(c.booking_url)?`<a class="btn-gold" href="${esc(safe(c.booking_url))}" target="_blank" rel="noopener noreferrer">📅 Prendre rendez-vous</a>`:''}${c.phone?`<a class="btn-ghost" href="tel:${esc(String(c.phone).replace(/[^+\d]/g,''))}">☎ Appeler</a>`:''}</div></div></article>`;
  }
  function render(){
    var grid=$('directory-results'),subset=filtered.slice(0,visible);
    $('result-count').textContent=filtered.length+' entreprise'+(filtered.length===1?'':'s')+' correspondante'+(filtered.length===1?'':'s');
    if(!filtered.length){grid.innerHTML='<div class="results-status">Aucune entreprise ne correspond pour le moment à ces critères. Essayez une autre ville, un autre métier ou un terme plus large.</div>';}else grid.innerHTML=subset.map(card).join('');
    $('show-more').hidden=filtered.length<=visible;
  }
  function search(){
    var city=norm($('filter-city').value), cat=norm($('filter-category').value), q=norm($('filter-keyword').value);
    filtered=allClients.filter(c=>{
      var loc=norm([c.city,c.service_areas].join(' '));
      var métier=norm(c.category);
      var all=norm([c.business_name,c.category,c.services,c.service_areas,c.advertorial_text,c.description].join(' '));
      return (!city||loc.includes(city))&&(!cat||métier===cat)&&(!q||all.includes(q));
    });
    visible=perPage;render();
  }
  async function loadClients(){
    try{
      var r=await fetch('/api/public/clients');if(!r.ok)throw Error('api');
      var d=await r.json();if(!d.ok)throw Error('api');
      allClients=Array.isArray(d.clients)?d.clients:[];fillCategory();search();
    }catch(e){$('directory-results').innerHTML='<div class="results-status">Le répertoire est momentanément indisponible. Réessayez un peu plus tard.</div>';$('result-count').textContent='';}
  }
  document.addEventListener('DOMContentLoaded',function(){
    $('directory-search').addEventListener('submit',e=>{e.preventDefault();search();});
    $('directory-search').addEventListener('reset',()=>setTimeout(search,0));
    $('show-more').addEventListener('click',()=>{visible+=perPage;render();});
    loadIssues();loadClients();loadCities();
  });
})();
