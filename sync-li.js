/**
 * Sync bordados da Loja Integrada → Dra Charm app
 * Carregado pelo bookmarklet. Roda na página do painel LI (mesma origem, cookies OK).
 * Lê a lista de pedidos + detalhe de cada um, filtra os com bordado, envia via postMessage pro app.
 */
(function(){
  const APP_ORIGIN = document.currentScript?.dataset?.appOrigin || 'https://producao-dra-charm.vercel.app';
  const SKU_LOGOMARCA = 'U4UDXDTVP';
  const SKU_PERSONALIZACAO = 'QGH2F6NFR';

  // ==================== UI de progresso ====================
  const oldPanel = document.getElementById('drachrm-sync-panel');
  if (oldPanel) oldPanel.remove();
  const panel = document.createElement('div');
  panel.id = 'drachrm-sync-panel';
  panel.style.cssText = 'position:fixed;top:20px;right:20px;background:#fff;border:3px solid #f59e0b;border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,.2);padding:16px 20px;z-index:2147483647;font-family:sans-serif;font-size:14px;min-width:280px;max-width:380px;color:#000';
  panel.innerHTML = '<div style="font-weight:bold;color:#f59e0b;margin-bottom:8px">🧵 Sync Dra Charm</div><div id="drachrm-sync-status">Iniciando...</div><div id="drachrm-sync-progress" style="margin-top:8px;height:6px;background:#eee;border-radius:3px;overflow:hidden"><div id="drachrm-sync-bar" style="width:0%;height:100%;background:#f59e0b;transition:width .2s"></div></div>';
  document.body.appendChild(panel);
  const setStatus = (t) => { document.getElementById('drachrm-sync-status').textContent = t; };
  const setProgress = (pct) => { document.getElementById('drachrm-sync-bar').style.width = pct + '%'; };

  // ==================== Descobre paginação e coleta TODOS os IDs ====================
  function collectIdsFromDoc(doc){
    return [...new Set(
      Array.from(doc.querySelectorAll('a[href*="/painel/pedido/"]'))
        .map(a => a.href.match(/pedido\/(\d+)/)?.[1])
        .filter(Boolean)
    )];
  }
  const currentUrl = new URL(window.location.href);
  const dateStart = currentUrl.searchParams.get('data_inicio');
  const dateEnd = currentUrl.searchParams.get('data_fim');
  if (!dateStart){
    setStatus('❌ Abra pelo botão "Sincronizar" no app (URL precisa ter ?data_inicio=... na aba do LI).');
    return;
  }
  const totalMatch = document.body.innerText.match(/Mostrando\s+\d+\s+de\s+(\d+)/i);
  const totalCount = totalMatch ? parseInt(totalMatch[1]) : 50;
  const pageSize = 50;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  setStatus(`Total ${totalCount} pedidos em ${totalPages} página(s). Coletando IDs...`);

  const allIdsSet = new Set(collectIdsFromDoc(document));
  // Páginas 2..N em PARALELO
  if (totalPages > 1){
    setStatus(`Coletando IDs de ${totalPages} páginas em paralelo...`);
    setProgress(20);
    const pageUrls = [];
    for (let p = 2; p <= totalPages; p++){
      pageUrls.push(`${currentUrl.origin}/painel/pedido/listar/pagina/${p}?data_inicio=${encodeURIComponent(dateStart)}&data_fim=${encodeURIComponent(dateEnd)}`);
    }
    const pageResults = await Promise.all(pageUrls.map(async url => {
      try {
        const html = await fetch(url, {credentials:'include'}).then(r => r.text());
        const doc = new DOMParser().parseFromString(html, 'text/html');
        return collectIdsFromDoc(doc);
      } catch(e){ return []; }
    }));
    for (const ids of pageResults) for (const id of ids) allIdsSet.add(id);
  }
  const allIds = [...allIdsSet];
  const orderIds = allIds;
  if (orderIds.length === 0){
    setStatus('❌ Nenhum pedido encontrado nesta data.');
    setTimeout(() => panel.remove(), 5000);
    return;
  }
  setStatus(`Encontrei ${orderIds.length} pedidos. Analisando um a um...`);

  // ==================== Parse do detalhe do pedido ====================
  function parseOrderDetail(html, orderId){
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const txt = doc.body.innerText;
    const skus = [...txt.matchAll(/SKU:\s*([^\n]+)/g)].map(m=>m[1].trim());
    const hasLogo = skus.includes(SKU_LOGOMARCA);
    const hasPerso = skus.includes(SKU_PERSONALIZACAO);
    if (!hasLogo && !hasPerso) return null;

    // Filtro de status: pula cancelados/aguardando/disputa/etc
    const situacoes = [...txt.matchAll(/Situação:\s*([^\n]+)/g)].map(m => m[1].trim());
    const ultimaSituacao = situacoes[situacoes.length-1] || '';
    const statusInvalido = /cancelad|devolvid|chargeback|disputa|análise|analise|aguardando pgto|solicitad/i;
    if (statusInvalido.test(ultimaSituacao)) return null;

    // Cliente: aceita case-insensitive OR fallback pro endereço
    let cliente = '';
    const cliMatch = txt.match(/Pedido Efetuado\s*\t?\s*([^\n\t]+?)\s*\(cliente\)/i);
    if (cliMatch) cliente = cliMatch[1].trim();
    if (!cliente){
      const cliMatch2 = txt.match(/([\S ]+?)\s*\(cliente\)/);
      if (cliMatch2) cliente = cliMatch2[1].trim();
    }
    if (!cliente){
      const endMatch = txt.match(/Endereço de entrega[^\n]*\n\s*([^\n]+)/);
      if (endMatch) cliente = endMatch[1].trim();
    }
    cliente = cliente.split(/\s+/).map(w => w.length>2 ? w.charAt(0).toUpperCase()+w.slice(1).toLowerCase() : w).join(' ');

    const personaMatch = txt.match(/Personalização de produtos:?([\s\S]{0,5000}?)(?=Pagamento via|Detalhes do cliente|Endereço de entrega|ID\s+da transação|$)/);
    const persoBlock = personaMatch ? personaMatch[1] : '';
    const fields = {};
    for (const m of persoBlock.matchAll(/--\s+([A-ZÀ-Ýa-zà-ÿ][^:]*?):\s*(.*?)(?=--\s+[A-ZÀ-Ýa-zà-ÿ]|-{3,}|\*\*|={3,}|Mensagem\s+cartão|Pagamento\s+via|$)/gs)){
      const k = m[1].trim().toLowerCase().replace(/\.$/,''), v = m[2].trim().replace(/\s+/g,' ');
      if (k && !fields[k]) fields[k] = v;
    }
    // Produtos com fotos — parser DOM (funciona em página fetched sem layout)
    const skusSkip = ['U4UDXDTVP', 'QGH2F6NFR', 'embalagem-de-presente_hidden'];
    const produtos = [];
    const prodLinks = Array.from(doc.querySelectorAll('a[href*="/painel/catalogo/produto/"]'))
      .filter(a => /\/produto\/\d+\/editar/.test(a.href) && a.textContent.trim().length > 3);
    for (const link of prodLinks){
      const nome = link.textContent.trim();
      if (/Acréscimo|Embalagem/i.test(nome)) continue;
      const infoBox = link.parentElement;
      const row = infoBox?.parentElement;
      const boxTxt = infoBox?.textContent || '';
      const skuM = boxTxt.match(/SKU:\s*([^\s\n]+)/);
      const sku = skuM ? skuM[1].trim() : '';
      if (!sku || skusSkip.includes(sku)) continue;
      const tamM = boxTxt.match(/TAMANHO\s*:\s*([^\s\n]+)/);
      const qtyM = (row?.textContent || '').match(/Qtd:\s*(\d+)/);
      const img = row?.querySelector('img');
      produtos.push({
        nome, sku,
        tamanho: tamM ? tamM[1].trim() : '',
        qtd: qtyM ? parseInt(qtyM[1]) : 1,
        imagem_url: img?.src || null,
      });
    }
    // Marca produtos que TÊM bordado (persoBlock começa cada peça com "** SKU **")
    const bordadoSkus = new Set();
    for (const m of persoBlock.matchAll(/\*\*\s*([^\s\[*]+)/g)){
      bordadoSkus.add(m[1].trim().toLowerCase());
    }
    for (const p of produtos){
      if (bordadoSkus.has((p.sku||'').toLowerCase())) p.bordado = true;
    }
    // Cores: "#hex-Nome"
    let corHex = null, corNome = null;
    if (fields['cores']){
      const cm = fields['cores'].match(/^(#[0-9a-fA-F]{3,8})-(.+)$/);
      if (cm){ corHex = cm[1]; corNome = cm[2].trim(); }
      else { corNome = fields['cores']; }
    }
    // Imagem
    let imgUrl = null;
    if (fields['fazer upload da imagem']) imgUrl = fields['fazer upload da imagem'];
    else {
      const imgM = persoBlock.match(/https?:\/\/[^\s\n]+\.(?:jpg|jpeg|png|pdf|svg|gif)/i);
      if (imgM) imgUrl = imgM[0];
    }

    let tipo = null;
    if (hasLogo && hasPerso) tipo = 'ambos';
    else if (hasLogo) tipo = 'logomarca';
    else if (hasPerso) tipo = 'nome_profissao';

    return {
      pedido_numero: orderId,
      pedido_cliente: cliente,
      pedido_url: `https://app.lojaintegrada.com.br/painel/pedido/${orderId}/detalhar`,
      bordado_tipo: tipo,
      bordado_linha1: fields['linha 1*'] || fields['linha 1'] || null,
      bordado_linha2: fields['linha 2*'] || fields['linha 2'] || null,
      bordado_cor_hex: corHex,
      bordado_cor_nome: corNome,
      bordado_fonte: fields['tipo de letra'] || null,
      bordado_lado: fields['lados'] || fields['lado'] || null,
      bordado_imagem_url: imgUrl,
      bordado_detalhes: fields['detalhes do bordado (opcional)'] || fields['detalhes do bordado'] || null,
      pedido_produtos: produtos.length ? produtos : null,
    };
  }

  // ==================== Fetch em paralelo (4 por vez) ====================
  (async () => {
    const results = [];
    let done = 0;
    const CONCURRENCY = 10;
    for (let i=0; i<orderIds.length; i += CONCURRENCY){
      const batch = orderIds.slice(i, i+CONCURRENCY);
      const parsed = await Promise.all(batch.map(async id => {
        try {
          const r = await fetch(`https://app.lojaintegrada.com.br/painel/pedido/${id}/detalhar`, {credentials:'include'});
          const html = await r.text();
          return parseOrderDetail(html, id);
        } catch (e){ return null; }
      }));
      for (const p of parsed){ if (p) results.push(p); }
      done += batch.length;
      setStatus(`Analisando ${done}/${orderIds.length} pedidos... (${results.length} com bordado até agora)`);
      setProgress(Math.round((done/orderIds.length)*100));
    }

    if (results.length === 0){
      setStatus('✓ Analisei tudo. Nenhum pedido com bordado nesta data.');
      setTimeout(() => panel.remove(), 5000);
      return;
    }
    setStatus(`Enviando ${results.length} pedidos com bordado pro app Dra Charm...`);
    if (!window.opener){
      setStatus('❌ Esta aba não foi aberta pelo botão "Sincronizar" no app. Abre pelo app.');
      return;
    }
    window.opener.postMessage({type:'draCharmBordados', orders: results}, APP_ORIGIN);
    setStatus(`✅ ${results.length} pedidos enviados! Volta pra aba do Dra Charm — os cards já estão lá.`);
    setTimeout(() => panel.remove(), 8000);
  })();
})();
