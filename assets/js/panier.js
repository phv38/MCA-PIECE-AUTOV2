const STORAGE_KEYS = ['mca_cart', 'mca_panier'];

function formatPrix(valeur) {
  return new Intl.NumberFormat('fr-FR', {
    style: 'currency',
    currency: 'EUR'
  }).format(Number(valeur) || 0);
}

function normaliserPanier(items) {
  if (!Array.isArray(items)) return [];

  return items
    .map((item) => ({
      id: String(item.id),
      nom: item.nom || item.name || 'Produit',
      prix: Number(item.prix ?? item.price ?? 0),
      image: item.image || item.img || '',
      quantite: Number(item.quantite ?? item.quantity ?? 1),
      quantity: Number(item.quantite ?? item.quantity ?? 1)
    }))
    .filter((item) => item.id && item.quantite > 0);
}

function lireCartesBrutes() {
  for (const key of STORAGE_KEYS) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const data = JSON.parse(raw);
      if (Array.isArray(data)) return data;
    } catch (error) {
      console.warn('Erreur lecture LocalStorage:', key, error);
    }
  }
  return [];
}

function resolveProduitDepuisStock(item) {
  const productList = Array.isArray(window.products) ? window.products : [];
  const featured = productList.find((product) => String(product.id) === String(item.id));
  if (!featured) return item;

  return {
    ...item,
    nom: item.nom || item.name || featured.name,
    name: item.name || item.nom || featured.name,
    prix: Number(item.prix ?? item.price ?? featured.price),
    price: Number(item.price ?? item.prix ?? featured.price),
    image: item.image || item.img || featured.image,
    quantite: Number(item.quantite ?? item.quantity ?? 1),
    quantity: Number(item.quantite ?? item.quantity ?? 1)
  };
}

function getPanier() {
  try {
    return normaliserPanier(lireCartesBrutes()).map(resolveProduitDepuisStock);
  } catch (error) {
    console.error('Erreur lecture panier:', error);
    return [];
  }
}

function sauvegarderPanier(panier) {
  const normalized = normaliserPanier(panier).map((item) => ({
    id: Number.isFinite(Number(item.id)) ? Number(item.id) : item.id,
    nom: item.nom,
    prix: Number(item.prix),
    image: item.image,
    quantite: Number(item.quantite),
    quantity: Number(item.quantite)
  }));

  localStorage.setItem('mca_cart', JSON.stringify(normalized));
  localStorage.setItem('mca_panier', JSON.stringify(normalized));
  if (typeof renderPanier === 'function') {
    renderPanier();
  }
  return normalized;
}

function ajouterProduit(id, nom, prix, image) {
  const panier = getPanier();
  const produitId = String(id);
  const index = panier.findIndex((item) => String(item.id) === produitId);

  if (index >= 0) {
    panier[index].nom = String(nom || panier[index].nom);
    panier[index].name = panier[index].nom;
    panier[index].prix = Number(prix ?? panier[index].prix);
    panier[index].price = panier[index].prix;
    panier[index].image = String(image || panier[index].image || '');
    panier[index].quantite += 1;
    panier[index].quantity = panier[index].quantite;
  } else {
    panier.push({
      id: produitId,
      nom: String(nom),
      prix: Number(prix),
      image: String(image || ''),
      quantite: 1,
      quantity: 1
    });
  }

  return sauvegarderPanier(panier);
}

function supprimerProduit(id) {
  const panier = getPanier().filter((item) => String(item.id) !== String(id));
  return sauvegarderPanier(panier);
}

function modifierQuantite(id, quantite) {
  const panier = getPanier()
    .map((item) => {
      if (String(item.id) !== String(id)) return item;
      const nouvelleQuantite = Number(quantite) || 0;
      const safe = Math.max(0, nouvelleQuantite);
      return { ...item, quantite: safe, quantity: safe };
    })
    .filter((item) => item.quantite > 0);

  return sauvegarderPanier(panier);
}

function viderPanier() {
  localStorage.setItem('mca_cart', JSON.stringify([]));
  localStorage.setItem('mca_panier', JSON.stringify([]));
  if (typeof renderPanier === 'function') {
    renderPanier();
  }
  return [];
}

function calculerTotal() {
  return getPanier().reduce((total, item) => {
    return total + (Number(item.prix) || 0) * (Number(item.quantite) || 0);
  }, 0);
}

function echapperHtml(valeur) {
  return String(valeur ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);
}

function normalizeOrderError(error) {
  const message = String(error?.message || '');

  if (message.includes('Could not find the function public.decrement_stock(product_id, quantity) in the schema cache')) {
    return new Error('La fonction SQL public.decrement_stock(product_id, quantity) est absente du cache Supabase. Exécutez le script projet/supabase/admin_setup.sql dans Supabase puis rechargez le cache PostgREST.');
  }

  return error instanceof Error ? error : new Error(message || 'erreur inconnue');
}

function renderPanier() {
  const panier = getPanier();
  const cartList = document.getElementById('cartList');
  const cartCountBadge = document.getElementById('cartCountBadge');
  const subtotalValue = document.getElementById('subtotalValue');
  const totalValue = document.getElementById('totalValue');
  const shippingValue = document.getElementById('shippingValue');

  const totalGeneral = calculerTotal();
  const livraison = totalGeneral > 0 ? 9.9 : 0;
  const montantFinal = totalGeneral + livraison;
  const totalArticles = panier.reduce((sum, item) => sum + Number(item.quantite || 0), 0);

  if (cartCountBadge) {
    cartCountBadge.textContent = `${totalArticles} article${totalArticles > 1 ? 's' : ''}`;
  }

  document.querySelectorAll('[data-cart-count]').forEach((badge) => {
    badge.textContent = String(totalArticles);
    badge.setAttribute('aria-label', `${totalArticles} article${totalArticles > 1 ? 's' : ''} dans le panier`);
    badge.hidden = totalArticles === 0;
  });

  if (!cartList) return;

  if (!panier.length) {
    cartList.innerHTML = `
      <div class="card border-0 bg-light">
        <div class="card-body py-5 text-center text-muted">
          <i class="fa-solid fa-bag-shopping fa-2x mb-3" aria-hidden="true"></i>
          <p class="mb-0">Votre panier est vide.</p>
        </div>
      </div>
    `;

    if (subtotalValue) subtotalValue.textContent = formatPrix(0);
    if (shippingValue) shippingValue.textContent = formatPrix(0);
    if (totalValue) totalValue.textContent = formatPrix(0);
    return;
  }

  cartList.innerHTML = panier.map((item) => {
    const ligne = (Number(item.prix) || 0) * (Number(item.quantite) || 0);
    const id = echapperHtml(item.id);
    const nom = echapperHtml(item.nom);
    const image = echapperHtml(item.image || 'https://placehold.co/120x120/f5f5f5/111111?text=Produit');
    return `
      <article class="card mb-3" data-id="${id}">
        <div class="card-body d-flex flex-column flex-md-row align-items-md-center gap-3">
          <img src="${image}" alt="${nom}" class="rounded" style="width:76px;height:76px;object-fit:cover;" />
          <div class="cart-item-details flex-grow-1">
            <div class="cart-item-title">${nom}</div>
            <div class="cart-item-price">${formatPrix(item.prix)} / unité</div>
            <div class="qty-controls">
              <button class="qty-btn" data-action="minus" data-id="${id}" type="button" aria-label="Diminuer la quantité" ${item.quantite <= 1 ? 'disabled' : ''}>−</button>
              <span class="qty-value">${item.quantite}</span>
              <button class="qty-btn" data-action="plus" data-id="${id}" type="button" aria-label="Augmenter la quantité">+</button>
            </div>
          </div>
          <div class="text-md-end ms-md-auto">
            <div class="fw-bold mb-2">${formatPrix(ligne)}</div>
            <button class="btn btn-link text-danger p-0 remove-btn" data-id="${id}" type="button">Supprimer</button>
          </div>
        </div>
      </article>
    `;
  }).join('');

  if (subtotalValue) subtotalValue.textContent = formatPrix(totalGeneral);
  if (shippingValue) shippingValue.textContent = formatPrix(livraison);
  if (totalValue) totalValue.textContent = formatPrix(montantFinal);

  cartList.querySelectorAll('.qty-btn').forEach((button) => {
    button.addEventListener('click', () => {
      const id = button.dataset.id;
      const action = button.dataset.action;
      const currentItem = panier.find((item) => String(item.id) === String(id));
      if (!currentItem) return;
      const nextQty = action === 'plus' ? currentItem.quantite + 1 : Math.max(1, currentItem.quantite - 1);
      if (nextQty === currentItem.quantite) return;
      modifierQuantite(id, nextQty);
    });
  });

  cartList.querySelectorAll('.remove-btn').forEach((button) => {
    button.addEventListener('click', () => {
      supprimerProduit(button.dataset.id);
    });
  });
}

function chargerPanier() {
  return getPanier();
}

function getCurrentUserForCheckout() {
  return window.mcaAuth?.getUser ? window.mcaAuth.getUser() : Promise.resolve({ data: { user: null }, error: { message: 'Supabase Auth indisponible.' } });
}

async function validateCartStock(cartItems = []) {
  const items = Array.isArray(cartItems) ? cartItems : [];
  const validations = [];

  for (const item of items) {
    const productId = Number(item.id ?? item.product_id ?? 0);
    const quantity = Number(item.quantite ?? item.quantity ?? 1);

    if (!productId) {
      throw new Error('Produit invalide dans le panier pour la validation du stock.');
    }

    const { data: product, error } = await window.supabaseClient
      .from('produits')
      .select('id, nom, stock, stock_min')
      .eq('id', productId)
      .maybeSingle();

    console.log('[orders] stock validation lookup', {
      productId,
      quantity,
      product,
      error
    });

    if (error) {
      throw normalizeOrderError(error);
    }

    if (!product) {
      throw new Error(`Produit #${productId} introuvable dans la table produits.`);
    }

    const availableStock = Number(product.stock ?? 0);
    const stockMin = Number(product.stock_min ?? 0);
    const requestedQty = Number(quantity || 0);
    const nextStock = availableStock - requestedQty;

    console.log('[orders] stock validation result', {
      productId,
      productName: product.nom,
      availableStock,
      stockMin,
      requestedQty,
      nextStock,
      isOutOfStock: availableStock === 0,
      isLowStock: availableStock <= stockMin
    });

    if (requestedQty > availableStock) {
      throw new Error(`Stock insuffisant pour « ${product.nom || 'ce produit'} » : disponible ${availableStock}, demandé ${requestedQty}.`);
    }

    validations.push({
      productId,
      productName: product.nom || 'Produit',
      currentStock: availableStock,
      stockMin,
      requestedQty,
      nextStock
    });
  }

  return validations;
}

async function decrementProductStockFromCart(cartItems = []) {
  const items = Array.isArray(cartItems) ? cartItems : [];

  for (const item of items) {
    const productId = Number(item.id ?? item.product_id ?? 0);
    const quantity = Number(item.quantite ?? item.quantity ?? 1);

    if (!productId || quantity <= 0) continue;

    const rpcPayload = {
      product_id: productId,
      quantity
    };

    console.log('[RPC] decrement_stock called');
    console.log('[RPC] payload', rpcPayload);

    const { data, error } = await window.supabaseClient.rpc('decrement_stock', rpcPayload);

    const rpcResult = Array.isArray(data) ? data[0] : data;

    console.log('[RPC] result', data);
    console.log('[RPC] error', error);

    console.log('[orders] decrementProductStock update result', {
      produitConcerne: {
        id: productId,
        nom: rpcResult?.nom || item.nom || item.name || null
      },
      stockAvant: rpcResult?.stock_avant ?? null,
      stockApres: rpcResult?.stock_apres ?? null,
      resultatUpdateSupabase: data,
      erreurComplete: error
        ? {
            message: error.message,
            details: error.details,
            hint: error.hint,
            code: error.code,
            fullError: error
          }
        : null
    });

    if (!error && !rpcResult) {
      console.warn('[orders] decrementProductStock possible RLS block on produits update', {
        produitConcerne: {
          id: productId,
          nom: item.nom || item.name || null
        },
        resultatUpdateSupabase: data,
        erreurComplete: error,
        diagnostic: 'Aucune ligne retournée par la RPC decrement_stock. Vérifiez les droits EXECUTE et la fonction SQL.'
      });
    }

    if (error) {
      throw error;
    }

    if (!rpcResult) {
      throw new Error(`La décrémentation du stock n'a retourné aucun résultat pour le produit #${productId}.`);
    }
  }
}

async function createOrder({ userId, total, statut = 'En attente' }) {
  if (!userId) {
    throw new Error('Utilisateur non connecté pour créer une commande.');
  }

  const payload = {
    user_id: userId,
    total: Number(total) || 0,
    statut,
    created_at: new Date().toISOString()
  };

  console.log('[orders] createOrder payload', payload);
  console.log('[orders] createOrder before insert into commandes', {
    table: 'commandes',
    payload
  });

  const { data, error } = await window.supabaseClient
    .from('commandes')
    .insert([payload])
    .select()
    .single();

  console.log('[orders] createOrder response', { data, error });

  if (error) {
    throw error;
  }

  return data;
}

async function saveOrder({ userId, total, statut = 'En attente' }) {
  return createOrder({ userId, total, statut });
}

async function triggerOrderEmails(orderId) {
  if (!orderId || !window.supabaseClient?.functions?.invoke) return null;

  const payload = { orderId };

  console.log('[EMAIL] before invoke');
  console.log('[EMAIL] payload', payload);

  const response = await window.supabaseClient.functions.invoke('send-order-emails', {
    body: payload
  });

  console.log('[EMAIL] response', response.data);
  console.log('[EMAIL] error', response.error);

  if (response.error) {
    throw normalizeOrderError(response.error);
  }

  return response.data;
}

async function submitOrder(cartItems = [], userId = null) {
  const safeItems = Array.isArray(cartItems) ? cartItems : [];
  const activeUserId = userId || (await getCurrentUserForCheckout()).data?.user?.id;

  if (!activeUserId) {
    throw new Error('Vous devez être connecté pour valider une commande.');
  }

  const stockChecks = await validateCartStock(safeItems);
  console.log('[orders] submitOrder stock validation checks', stockChecks);

  const total = safeItems.reduce((sum, item) => {
    const price = Number(item.prix ?? item.price ?? 0);
    const quantity = Number(item.quantite ?? item.quantity ?? 1);
    return sum + price * quantity;
  }, 0);

  const order = await createOrder({ userId: activeUserId, total, statut: 'En attente' });

  const details = safeItems.map((item) => ({
    commande_id: order.id,
    produit_id: Number(item.id) || item.id,
    quantite: Number(item.quantite ?? item.quantity ?? 1),
    prix: Number(item.prix ?? item.price ?? 0)
  }));

  console.log('[orders] submitOrder details payload', details);
  console.log('[orders] submitOrder before insert into commande_details', {
    table: 'commande_details',
    details
  });

  const { data, error } = await window.supabaseClient
    .from('commande_details')
    .insert(details)
    .select();

  console.log('[orders] submitOrder details response', { data, error });

  if (error) {
    throw error;
  }

  await decrementProductStockFromCart(safeItems);

  try {
    await window.mcaInvoices?.ensureInvoiceForOrderId?.(order.id);
  } catch (invoiceError) {
    console.error('[invoice] automatic generation failed after submitOrder', invoiceError);
  }

  try {
    await triggerOrderEmails(order.id);
  } catch (emailError) {
    console.error('[emails] automatic sending failed after submitOrder', emailError);
  }

  return { order, items: data || details };
}

async function checkout() {
  const panier = getPanier();

  if (!panier.length) {
    window.alert('Votre panier est vide.');
    return null;
  }

  if (!window.supabaseClient) {
    window.alert('La connexion Supabase est indisponible.');
    return null;
  }

  try {
    const { data: userData, error: userError } = await getCurrentUserForCheckout();

    if (userError || !userData?.user) {
      window.location.href = 'login.html?redirect=panier.html';
      return null;
    }

    const result = await submitOrder(panier, userData.user.id);
    viderPanier();
    window.location.href = `confirmation.html?order_id=${encodeURIComponent(result.order.id)}`;
    return result;
  } catch (error) {
    const normalizedError = normalizeOrderError(error);
    console.error('[orders] checkout failed', normalizedError);
    window.alert(`La commande n’a pas pu être enregistrée : ${normalizedError.message || 'erreur inconnue'}`);
    return null;
  }
}

async function validateOrder(cartItems = [], userId = null) {
  const panier = Array.isArray(cartItems) && cartItems.length ? cartItems : getPanier();

  if (!panier.length) {
    window.alert('Votre panier est vide.');
    return null;
  }

  if (!window.supabaseClient) {
    window.alert('La connexion Supabase est indisponible.');
    return null;
  }

  try {
    const { data: userData, error: userError } = userId
      ? { data: { user: { id: userId } }, error: null }
      : await getCurrentUserForCheckout();

    if (userError || !userData?.user) {
      window.location.href = 'login.html?redirect=panier.html';
      return null;
    }

    const activeUserId = userId || userData.user.id;
    const stockChecks = await validateCartStock(panier);
    console.log('[orders] validateOrder stock validation checks', stockChecks);

    const total = Number(panier.reduce((sum, item) => {
      const price = Number(item.prix ?? item.price ?? 0);
      const quantity = Number(item.quantite ?? item.quantity ?? 1);
      return sum + price * quantity;
    }, 0)) || 0;

    const orderPayload = {
      user_id: activeUserId,
      total,
      statut: 'En attente',
      created_at: new Date().toISOString()
    };

    console.log('[orders] validateOrder payload', orderPayload);
    console.log('[orders] validateOrder before insert into commandes', {
      table: 'commandes',
      payload: orderPayload
    });

    const { data: commande, error: commandeError } = await window.supabaseClient
      .from('commandes')
      .insert([orderPayload])
      .select()
      .single();

    console.log('[orders] validateOrder response', { data: commande, error: commandeError });

    if (commandeError) {
      throw commandeError;
    }

    const details = panier.map((item) => ({
      commande_id: commande.id,
      produit_id: Number(item.id) || item.id,
      quantite: Number(item.quantite || item.quantity || 1),
      prix: Number(item.prix || item.price || 0)
    }));

    console.log('[orders] validateOrder details payload', details);
    console.log('[orders] validateOrder before insert into commande_details', {
      table: 'commande_details',
      details
    });

    const { error: detailsError } = await window.supabaseClient
      .from('commande_details')
      .insert(details);

    console.log('[orders] validateOrder details response', { error: detailsError });

    if (detailsError) {
      throw detailsError;
    }

    await decrementProductStockFromCart(panier);

    try {
      await window.mcaInvoices?.ensureInvoiceForOrderId?.(commande.id);
    } catch (invoiceError) {
      console.error('[invoice] automatic generation failed after validateOrder', invoiceError);
    }

    try {
      await triggerOrderEmails(commande.id);
    } catch (emailError) {
      console.error('[emails] automatic sending failed after validateOrder', emailError);
    }

    viderPanier();
    window.location.href = `confirmation.html?order_id=${encodeURIComponent(commande.id)}`;
    return { order: commande, items: details };
  } catch (error) {
    const normalizedError = normalizeOrderError(error);
    console.error('[orders] validation failed', normalizedError);
    window.alert(`La commande n’a pas pu être enregistrée : ${normalizedError.message || 'erreur inconnue'}`);
    return null;
  }
}

async function validerCommande() {
  return validateOrder();
}

window.ajouterProduit = ajouterProduit;
window.supprimerProduit = supprimerProduit;
window.modifierQuantite = modifierQuantite;
window.viderPanier = viderPanier;
window.calculerTotal = calculerTotal;
window.sauvegarderPanier = sauvegarderPanier;
window.chargerPanier = chargerPanier;
window.renderPanier = renderPanier;
window.getPanier = getPanier;
window.updateCartBadge = () => renderPanier();
window.validerCommande = validerCommande;
window.validateOrder = validateOrder;
window.createOrder = createOrder;
window.saveOrder = saveOrder;
window.submitOrder = submitOrder;
window.checkout = checkout;

document.addEventListener('DOMContentLoaded', () => {
  const cartList = document.getElementById('cartList');
  const emptyCartBtn = document.getElementById('emptyCartBtn');
  const validateOrderButton = document.getElementById('validate-order-button');

  if (emptyCartBtn) {
    emptyCartBtn.addEventListener('click', () => {
      viderPanier();
    });
  }

  if (validateOrderButton) {
    validateOrderButton.addEventListener('click', () => {
      validerCommande();
    });
  }

  if (cartList) {
    renderPanier();
  } else {
    renderPanier();
  }
});

window.addEventListener('storage', (event) => {
  if (STORAGE_KEYS.includes(event.key)) renderPanier();
});
