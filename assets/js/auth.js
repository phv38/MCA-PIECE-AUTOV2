function setMessage(message, type = 'info') {
  const element = document.getElementById('auth-message');
  if (!element) return;

  element.textContent = message;
  element.style.color = type === 'error' ? '#d20d1b' : type === 'success' ? '#1d7a46' : '#6f6f6f';
}

async function handleLoginSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const email = form.elements.email.value.trim();
  const password = form.elements.password.value;

  setMessage('Connexion en cours…');
  const { data, error } = await window.mcaAuth.signInWithPassword({ email, password });

  if (error) {
    setMessage(error.message, 'error');
    return;
  }

  if (!data?.session) {
    setMessage('Connexion sans session. Vérifiez votre email si la confirmation est activée.', 'error');
    return;
  }

  window.location.href = 'compte.html';
}

async function handleRegisterSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const fullName = form.elements.full_name.value.trim();
  const email = form.elements.email.value.trim();
  const password = form.elements.password.value;
  const confirmPassword = form.elements.confirmPassword.value;
  const phone = form.elements.phone.value.trim();

  if (password.length < 6) {
    setMessage('Le mot de passe doit contenir au moins 6 caractères.', 'error');
    return;
  }
  if (password !== confirmPassword) {
    setMessage('Les mots de passe ne correspondent pas.', 'error');
    return;
  }

  setMessage('Création du compte Supabase en cours…');
  console.log('[handleRegisterSubmit] start signup', { email, fullName, phone });

  const { data, error } = await window.mcaAuth.signUp({
    email,
    password,
    options: {
      data: { full_name: fullName, phone, role: 'client' },
      emailRedirectTo: `${window.location.origin}${window.location.pathname.replace(/[^/]*$/, 'login.html')}`
    }
  });

  console.log('[handleRegisterSubmit] signup response', { data, error });

  if (error) {
    console.error('[handleRegisterSubmit] signUp failed', error);
    setMessage(error.message, 'error');
    return;
  }

  const user = data?.user;
  console.log('[handleRegisterSubmit] user returned', user);

  if (!user?.id) {
    console.warn('[handleRegisterSubmit] user id missing; cannot verify profil row');
    setMessage('Compte créé dans Supabase, mais nous n’avons pas reçu l’ID utilisateur pour vérifier le profil.', 'error');
    return;
  }

  const profileResult = await window.mcaAuth.ensureProfile({
    id: user.id,
    email: user.email,
    role: user.user_metadata?.role || 'client',
    createdAt: user.created_at
  });

  console.log('[handleRegisterSubmit] profileResult', profileResult);

  if (profileResult?.error && !profileResult.exists) {
    console.error('[handleRegisterSubmit] real Supabase error while verifying profile', profileResult.error);
    setMessage('Compte créé dans Supabase, mais la création du profil a échoué. Vérifiez la table profils et les logs.', 'error');
    return;
  }

  if (profileResult?.exists || profileResult?.reason === 'trigger_created_without_session') {
    console.log('[handleRegisterSubmit] profile exists or was created by DB trigger; success display triggered');

    if (data?.session) {
      setMessage('Compte créé et connecté. Ouverture de votre espace…', 'success');
      window.location.href = 'compte.html';
      return;
    }

    setMessage('Compte créé dans Supabase. Consultez votre email pour confirmer l’inscription.', 'success');
    return;
  }

  console.warn('[handleRegisterSubmit] no real Supabase error, but profile still not confirmed', profileResult);
  setMessage('Compte créé dans Supabase, mais aucun profil n’a été trouvé dans la table profils.', 'error');
}

async function handleForgotPassword(event) {
  event.preventDefault();
  const email = document.querySelector('[name="email"]')?.value.trim();

  if (!email) {
    setMessage('Saisissez votre email dans le champ ci-dessus avant de demander la réinitialisation.', 'error');
    return;
  }

  const { error } = await window.mcaAuth.resetPasswordForEmail(email);
  if (error) {
    setMessage(error.message, 'error');
    return;
  }
  setMessage('Si cette adresse correspond à un compte, un lien de réinitialisation va être envoyé.', 'success');
}

async function handlePasswordUpdate(event) {
  event.preventDefault();
  const password = event.currentTarget.elements.password.value;
  if (password.length < 6) {
    setMessage('Le mot de passe doit contenir au moins 6 caractères.', 'error');
    return;
  }

  const { error } = await window.mcaAuth.updatePassword(password);
  if (error) {
    setMessage(error.message, 'error');
    return;
  }
  setMessage('Votre mot de passe a été modifié. Vous pouvez vous connecter.', 'success');
  window.history.replaceState({}, document.title, window.location.pathname);
  document.querySelector('[data-password-recovery]')?.setAttribute('hidden', '');
}

async function renderAccountPage() {
  const accountStatus = document.getElementById('account-status');
  const { data, error } = await window.mcaAuth.getUser();
  const user = data?.user;

  if (error || !user) {
    const { data: sessionData } = await window.mcaAuth.getSession();

    if (!sessionData?.session) {
      console.warn('renderAccountPage: no authenticated session, redirecting to login', { error, user });
      window.location.replace('login.html?auth_required=1');
      return;
    }

    console.warn('renderAccountPage: session exists but getUser failed, staying on account page', { error, user });
    if (accountStatus) accountStatus.textContent = 'Votre session est en cours de synchronisation. Veuillez patienter…';
    return;
  }

  console.log('renderAccountPage: current user', user);

  const profileResult = await window.mcaAuth.ensureProfile({
    id: user.id,
    email: user.email,
    role: user.user_metadata?.role || 'client',
    createdAt: user.created_at
  });

  console.log('renderAccountPage: profile ensure result', profileResult);

  if (accountStatus) accountStatus.textContent = `Connecté en tant que ${user.email}`;
  const fields = {
    full_name: user.user_metadata?.full_name || user.user_metadata?.name || 'Utilisateur',
    email: user.email || '',
    phone: user.user_metadata?.phone || 'Non renseigné',
    role: user.user_metadata?.role || 'client'
  };

  Object.entries(fields).forEach(([key, value]) => {
    const field = document.querySelector(`[data-account="${key}"]`);
    if (field) field.value = value;
  });

  document.getElementById('account-content')?.removeAttribute('hidden');
}

function getOrderReference(order, fallbackIndex = 0) {
  const year = new Date(order?.created_at || Date.now()).getFullYear() || new Date().getFullYear();
  const rawId = Number(order?.id ?? fallbackIndex + 1);
  const numericPart = Number.isFinite(rawId) && rawId > 0 ? rawId : fallbackIndex + 1;
  return `CMD-${year}-${String(numericPart).padStart(4, '0')}`;
}

function getOrderStatusClass(status = '') {
  const normalized = String(status || '').trim().toLowerCase();

  if (normalized.includes('attente')) return 'status-badge status-attente';
  if (normalized.includes('préparation') || normalized.includes('preparation')) return 'status-badge status-preparation';
  if (normalized.includes('expédi') || normalized.includes('expedie')) return 'status-badge status-expedie';
  if (normalized.includes('termin') || normalized.includes('livr')) return 'status-badge status-terminee';
  if (normalized.includes('annul')) return 'status-badge status-annulee';

  return 'status-badge status-attente';
}

async function renderOrdersForAccount() {
  const listNode = document.getElementById('account-orders-list');
  if (!listNode) return;

  try {
    const { data: userData, error: userError } = await window.mcaAuth.getUser();
    if (userError || !userData?.user) {
      listNode.innerHTML = '<div class="order-empty">Vous devez être connecté pour voir vos commandes.</div>';
      return;
    }

    const { data: orders, error: ordersError } = await window.supabaseClient
      .from('commandes')
      .select('*')
      .eq('user_id', userData.user.id)
      .order('created_at', { ascending: false });

    if (ordersError) {
      console.error('[orders] account load failed', ordersError);
      listNode.innerHTML = `<div class="order-empty order-empty--danger">Impossible de charger vos commandes : ${ordersError.message}</div>`;
      return;
    }

    if (!orders || !orders.length) {
      listNode.innerHTML = '<div class="order-empty">Aucune commande enregistrée pour le moment.</div>';
      return;
    }

    const populatedOrders = [];

    for (const [index, order] of orders.entries()) {
      const { data: details, error: detailsError } = await window.supabaseClient
        .from('commande_details')
        .select('*')
        .eq('commande_id', order.id);

      if (detailsError) {
        console.error('[orders] details load failed', detailsError);
        populatedOrders.push({ order, details: [], index });
        continue;
      }

      const enrichedDetails = [];
      for (const detail of details || []) {
        const { data: product, error: productError } = await window.supabaseClient
          .from('produits')
          .select('id, nom, prix')
          .eq('id', detail.produit_id)
          .maybeSingle();

        if (productError) {
          console.error('[orders] product lookup failed', productError);
        }

        enrichedDetails.push({
          ...detail,
          productName: product?.nom || 'Produit inconnu',
          productPrice: Number(product?.prix ?? detail.prix ?? 0),
          quantity: Number(detail.quantite || 0)
        });
      }

      populatedOrders.push({ order, details: enrichedDetails, index });
    }

    listNode.innerHTML = populatedOrders.map(({ order, details, index }) => {
      const reference = getOrderReference(order, index + 1);
      const date = new Date(order.created_at).toLocaleDateString('fr-FR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
      });
      const totalArticles = (details || []).reduce((sum, item) => sum + Number(item.quantity || 0), 0);
      const totalAmount = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(Number(order.total || 0));
      const statusClass = getOrderStatusClass(order.statut);
      const statusLabel = order.statut || 'En attente';

      return `
        <article class="order-card">
          <div class="order-card__header">
            <div>
              <div class="eyebrow">Commande</div>
              <h3>${reference}</h3>
            </div>
            <span class="${statusClass}">${statusLabel}</span>
          </div>

          <div class="order-stats">
            <div class="order-stat">
              <span>Date</span>
              <strong>${date}</strong>
            </div>
            <div class="order-stat">
              <span>Montant</span>
              <strong>${totalAmount}</strong>
            </div>
            <div class="order-stat">
              <span>Articles</span>
              <strong>${totalArticles}</strong>
            </div>
            <div class="order-stat">
              <span>Statut</span>
              <strong>${statusLabel}</strong>
            </div>
          </div>

          <div class="order-products">
            <div class="order-products__header">
              <span>Produits commandés</span>
            </div>
            <div class="order-product-grid">
              ${(details || []).map((item) => {
                const unitPrice = Number(item.productPrice || 0);
                const quantity = Number(item.quantity || 0);
                const subtotal = unitPrice * quantity;
                return `
                  <div class="order-product-card">
                    <div class="order-product-card__top">
                      <div class="order-product-card__name">${item.productName || 'Produit inconnu'}</div>
                      <div class="order-product-card__subtotal">${new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(subtotal)}</div>
                    </div>
                    <div class="order-product-card__meta">
                      <span>Prix unitaire : ${new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(unitPrice)}</span>
                      <span>Quantité : ${quantity}</span>
                    </div>
                  </div>
                `;
              }).join('') || '<div class="order-empty order-empty--small">Aucun produit associé.</div>'}
            </div>
          </div>

          <div class="order-card__footer">
            <a href="detail-commande.html?id=${encodeURIComponent(order.id)}" class="btn btn-primary btn-small">Voir la commande</a>
          </div>
        </article>
      `;
    }).join('');
  } catch (error) {
    console.error('[orders] account render failed', error);
    listNode.innerHTML = '<div class="order-empty order-empty--danger">Erreur lors du chargement des commandes.</div>';
  }
}

async function renderOrderDetailPage() {
  const detailNode = document.getElementById('order-detail-content');
  if (!detailNode) return;

  const params = new URLSearchParams(window.location.search);
  const orderId = params.get('id');

  if (!orderId) {
    detailNode.innerHTML = '<div class="order-empty order-empty--warning">Aucune commande sélectionnée.</div>';
    return;
  }

  try {
    const { data: userData, error: userError } = await window.mcaAuth.getUser();
    if (userError || !userData?.user) {
      window.location.replace('login.html?auth_required=1');
      return;
    }

    const { data: order, error: orderError } = await window.supabaseClient
      .from('commandes')
      .select('*')
      .eq('id', orderId)
      .eq('user_id', userData.user.id)
      .maybeSingle();

    if (orderError) {
      throw orderError;
    }

    if (!order) {
      detailNode.innerHTML = '<div class="order-empty order-empty--warning">Cette commande ne vous appartient pas ou est introuvable.</div>';
      return;
    }

    const { data: details, error: detailsError } = await window.supabaseClient
      .from('commande_details')
      .select('*')
      .eq('commande_id', order.id);

    if (detailsError) {
      throw detailsError;
    }

    const enrichedDetails = [];
    for (const detail of details || []) {
      const { data: product, error: productError } = await window.supabaseClient
        .from('produits')
        .select('id, nom, prix')
        .eq('id', detail.produit_id)
        .maybeSingle();

      if (productError) {
        console.error('[orders] detail product lookup failed', productError);
      }

      enrichedDetails.push({
        ...detail,
        productName: product?.nom || 'Produit inconnu',
        productPrice: Number(product?.prix ?? detail.prix ?? 0),
        quantity: Number(detail.quantite || 0)
      });
    }

    const reference = getOrderReference(order, 1);
    const date = new Date(order.created_at).toLocaleDateString('fr-FR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric'
    });
    const total = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(Number(order.total || 0));
    const totalArticles = enrichedDetails.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
    const statusClass = getOrderStatusClass(order.statut);
    const statusLabel = order.statut || 'En attente';

    detailNode.innerHTML = `
      <div class="order-detail-card">
        <div class="order-detail-card__header">
          <div>
            <div class="eyebrow">Commande</div>
            <h1>${reference}</h1>
          </div>
          <span class="${statusClass}">${statusLabel}</span>
        </div>

        <div class="order-detail-stats">
          <div class="order-detail-stat">
            <span>Date</span>
            <strong>${date}</strong>
          </div>
          <div class="order-detail-stat">
            <span>Montant</span>
            <strong>${total}</strong>
          </div>
          <div class="order-detail-stat">
            <span>Articles</span>
            <strong>${totalArticles}</strong>
          </div>
        </div>

        <div class="order-detail-products">
          <div class="order-detail-products__title">Produits commandés</div>
          <div class="order-detail-product-list">
            ${(enrichedDetails || []).map((item) => {
              const unitPrice = Number(item.productPrice || 0);
              const quantity = Number(item.quantity || 0);
              const subtotal = unitPrice * quantity;
              return `
                <div class="order-detail-product">
                  <div class="order-detail-product__header">
                    <div class="order-detail-product__name">${item.productName}</div>
                    <div class="order-detail-product__subtotal">${new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(subtotal)}</div>
                  </div>
                  <div class="order-detail-product__meta">
                    <span>${new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(unitPrice)} / unité</span>
                    <span>Qté : ${quantity}</span>
                  </div>
                </div>
              `;
            }).join('') || '<div class="order-empty order-empty--small">Aucun produit associé.</div>'}
          </div>
        </div>

        <div class="order-detail-actions">
          <a href="compte.html" class="btn btn-primary">Retour au compte</a>
        </div>
      </div>
    `;
  } catch (error) {
    console.error('[orders] detail page failed', error);
    detailNode.innerHTML = '<div class="order-empty order-empty--danger">Impossible de charger cette commande.</div>';
  }
}

async function handleLogout() {
  const { error } = await window.mcaAuth.signOut();
  if (error) {
    setMessage(error.message, 'error');
    return;
  }
  window.location.href = 'login.html';
}

async function redirectToAccountIfAuthenticated() {
  if (!window.mcaAuth.isConfigured()) return;

  const { data: sessionData, error: sessionError } = await window.mcaAuth.getSession();
  if (sessionError) {
    console.warn('redirectToAccountIfAuthenticated: getSession failed', sessionError);
    return;
  }

  if (!sessionData?.session) return;

  const { data: userData, error: userError } = await window.mcaAuth.getUser();
  if (userError) {
    console.warn('redirectToAccountIfAuthenticated: getUser failed; skipping redirect to avoid loop', userError);
    return;
  }

  if (userData?.user) {
    window.location.replace('compte.html');
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  const page = document.body.dataset.page;
  const yearNode = document.getElementById('year');
  if (yearNode) yearNode.textContent = new Date().getFullYear();

  if (!window.mcaAuth.isConfigured()) {
    setMessage(window.mcaAuth.getConfigError(), 'error');
  }

  if (page === 'login') {
    const loginForm = document.querySelector('[data-auth-form="login"]');
    loginForm?.addEventListener('submit', handleLoginSubmit);
    document.querySelector('[data-auth-action="forgot-password"]')?.addEventListener('click', handleForgotPassword);

    const params = new URLSearchParams(window.location.search);
    const requiresAuth = params.get('auth_required') === '1';

    if (new URLSearchParams(window.location.search).has('recovery')) {
      document.querySelector('[data-password-recovery]')?.removeAttribute('hidden');
      document.querySelector('[data-password-recovery]')?.addEventListener('submit', handlePasswordUpdate);
    } else if (window.mcaAuth.isConfigured() && !requiresAuth) {
      await redirectToAccountIfAuthenticated();
    }
  }

  if (page === 'register') {
    if (window.mcaAuth.isConfigured()) {
      const { data } = await window.mcaAuth.getSession();
      if (data?.session) {
        await redirectToAccountIfAuthenticated();
        return;
      }
    }
    document.querySelector('[data-auth-form="register"]')?.addEventListener('submit', handleRegisterSubmit);
  }

  if (page === 'account') {
    await renderAccountPage();
    await renderOrdersForAccount();
  }

  if (page === 'order-detail') {
    await renderOrderDetailPage();
  }

  document.querySelectorAll('[data-auth-action="logout"]').forEach((button) => {
    button.addEventListener('click', handleLogout);
  });
});
