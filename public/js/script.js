// AgriLink Zambia - shared script
// Each feature checks that its elements exist, so one file works on every page.

(function () {
    'use strict';

    /* ---------- Register: passwords must match ---------- */
    const password = document.getElementById('reg-password');
    const confirmPassword = document.getElementById('reg-confirm');

    if (password && confirmPassword) {
        const checkMatch = () => {
            const mismatch = confirmPassword.value !== '' && password.value !== confirmPassword.value;
            confirmPassword.setCustomValidity(mismatch ? 'Passwords do not match.' : '');
        };
        password.addEventListener('input', checkMatch);
        confirmPassword.addEventListener('input', checkMatch);
    }

    /* ---------- Date fields: no dates in the past ---------- */
    const today = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in local time
    document.querySelectorAll('input[type="date"]').forEach((input) => {
        input.min = today;
    });

    /* ---------- Products: search, filter and sort ---------- */
    const filterForm = document.querySelector('main form[action="products.html"]');
    const searchForm = document.querySelector('header form[role="search"]');
    const searchInput = document.getElementById('site-search');

    function renderListing(listing) {
        const item = document.createElement('li');
        const card = document.createElement('article');

        const title = document.createElement('h3');
        title.textContent = listing.product; // textContent keeps farmers' text from being run as HTML

        const listed = new Date(listing.createdAt).toLocaleDateString('en-GB', {
            day: 'numeric', month: 'short', year: 'numeric',
        });
        const lines = [
            `Price: ZMW ${Number(listing.pricePerKg).toFixed(2)} per kg`,
            `Available: ${Number(listing.quantityKg).toLocaleString('en-GB')} kg`,
            `Farmer: ${listing.farmerName}, ${listing.location}`,
            `Listed: ${listed}`,
        ].map((line) => {
            const paragraph = document.createElement('p');
            paragraph.textContent = line;
            return paragraph;
        });

        const order = document.createElement('a');
        order.href = 'buyers.html#place-order';
        order.textContent = 'Order';

        card.append(title, ...lines, order);
        item.append(card);
        return item;
    }

    async function showFarmerListings() {
        const list = document.querySelector('#farmer-listings ul');
        if (!list) return;
        try {
            const response = await fetch('/api/listings');
            if (!response.ok) return;
            const { listings } = await response.json();
            list.replaceChildren(...listings.map(renderListing));
        } catch {
            // No server: the page simply shows the example products
        }
    }

    async function initProducts() {
        await showFarmerListings(); // add farmers' cards first, so search/filter/sort include them
        const categorySelect = filterForm.elements.category;
        const sortSelect = filterForm.elements.sort;

        // Only the category sections that actually hold products
        const sections = [...document.querySelectorAll('main > section[id]')]
            .filter((section) => section.querySelector('article'));

        const parsePrice = (item) => {
            const match = item.textContent.match(/ZMW\s*([\d,.]+)/);
            return match ? parseFloat(match[1].replace(/,/g, '')) : 0;
        };

        // Remember each product's name, price and original position ("newest")
        sections.forEach((section) => {
            [...section.querySelector('ul').children].forEach((item, index) => {
                item.dataset.index = index;
                item.dataset.name = item.querySelector('h3').textContent.toLowerCase();
                item.dataset.price = parsePrice(item);
            });
        });

        // Live message for screen readers and everyone else
        const status = document.createElement('p');
        status.setAttribute('role', 'status');
        filterForm.after(status);

        const compare = (a, b) => {
            switch (sortSelect.value) {
                case 'price-low':
                    return a.dataset.price - b.dataset.price;
                case 'price-high':
                    return b.dataset.price - a.dataset.price;
                default:
                    return a.dataset.index - b.dataset.index;
            }
        };

        const applyFilters = () => {
            const term = searchInput.value.trim().toLowerCase();
            let total = 0;

            sections.forEach((section) => {
                const list = section.querySelector('ul');
                const categoryMatches = !categorySelect.value || section.id === categorySelect.value;
                const items = [...list.children].sort(compare);
                let visible = 0;

                items.forEach((item) => {
                    list.appendChild(item); // re-order in the page
                    const show = categoryMatches && item.dataset.name.includes(term);
                    item.hidden = !show;
                    if (show) visible++;
                });

                section.hidden = visible === 0;
                total += visible;
            });

            status.textContent = total === 0
                ? 'No products match your search.'
                : `Showing ${total} product${total === 1 ? '' : 's'}.`;
        };

        // Pick up ?q=maize&category=crops from the URL (the header search sends people here)
        const params = new URLSearchParams(window.location.search);
        if (params.get('q')) {
            searchInput.value = params.get('q');
        }
        const wantedCategory = params.get('category');
        if (wantedCategory && [...categorySelect.options].some((option) => option.value === wantedCategory)) {
            categorySelect.value = wantedCategory;
        }

        filterForm.addEventListener('submit', (event) => {
            event.preventDefault();
            applyFilters();
        });
        filterForm.addEventListener('change', applyFilters);
        searchInput.addEventListener('input', applyFilters);
        if (searchForm) {
            searchForm.addEventListener('submit', (event) => {
                event.preventDefault();
                applyFilters();
            });
        }

        applyFilters();
    }

    if (filterForm && searchInput) {
        initProducts();
    }

    /* ---------- Forms: send to the Node.js server ---------- */
    document.querySelectorAll('form[action^="/api/"]').forEach((form) => {
        const message = document.createElement('p');
        message.setAttribute('role', 'status');
        form.after(message);

        const show = (words, state) => {
            message.textContent = words;
            message.dataset.state = state;
        };

        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            const button = form.querySelector('button[type="submit"]');
            message.textContent = '';
            delete message.dataset.state;
            if (button) button.disabled = true;

            try {
                const response = await fetch(form.action, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                    body: JSON.stringify(Object.fromEntries(new FormData(form))),
                });
                const result = await response.json();

                show(result.message || (response.ok ? 'Done.' : 'Something went wrong.'), response.ok ? 'success' : 'error');

                if (response.ok) {
                    if (result.redirect) {
                        window.location.href = result.redirect;
                        return;
                    }
                    form.reset();
                }
            } catch {
                show('Could not reach the server. Please try again.', 'error');
            } finally {
                if (button) button.disabled = false;
            }
        });
    });

    /* ---------- Header: show the user's name and a Logout button when logged in ---------- */
    const accountList = document.querySelector('header nav[aria-label="Account"] ul');

    if (accountList) {
        fetch('/api/me')
            .then((response) => response.json())
            .then(({ user }) => {
                if (!user) return;

                const greeting = document.createElement('li');
                const name = document.createElement('a');
                name.href = 'account.html';
                name.textContent = `Hi, ${user.name.split(' ')[0]}`; // textContent keeps names safe from HTML injection
                if (window.location.pathname.endsWith('account.html')) name.setAttribute('aria-current', 'page');
                greeting.append(name);

                const logoutItem = document.createElement('li');
                const logout = document.createElement('button');
                logout.type = 'button';
                logout.textContent = 'Logout';
                logout.addEventListener('click', async () => {
                    await fetch('/api/logout', { method: 'POST' });
                    window.location.href = '/index.html';
                });
                logoutItem.append(logout);

                accountList.replaceChildren(greeting, logoutItem);
            })
            .catch(() => {
                // Opened as a plain file (no server): keep the Login and Register links
            });
    }

    /* ---------- My account page ---------- */
    const dateOptions = { day: 'numeric', month: 'short', year: 'numeric' };
    const formatDate = (value) => new Date(value).toLocaleDateString('en-GB', dateOptions);
    const formatDay = (value) => new Date(value).toLocaleDateString('en-GB', { ...dateOptions, timeZone: 'UTC' });
    const formatKg = (value) => `${Number(value).toLocaleString('en-GB')} kg`;

    function makeCard(title, lines, action) {
        const item = document.createElement('li');
        const card = document.createElement('article');

        const heading = document.createElement('h3');
        heading.textContent = title; // textContent keeps people's text from being run as HTML

        const paragraphs = lines.map((line) => {
            const paragraph = document.createElement('p');
            paragraph.textContent = line;
            return paragraph;
        });

        card.append(heading, ...paragraphs);
        if (action) card.append(action);
        item.append(card);
        return item;
    }

    function fillSection(id, cards, alwaysShow) {
        const section = document.getElementById(id);
        section.querySelector('ul').replaceChildren(...cards);
        section.querySelector('[data-empty]').hidden = cards.length > 0;
        section.hidden = cards.length === 0 && !alwaysShow;
    }

    function deleteButton(listing) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = 'Delete';
        button.addEventListener('click', async () => {
            if (!window.confirm(`Delete your listing for ${listing.product}?`)) return;
            button.disabled = true;
            try {
                const response = await fetch('/api/listings/delete', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id: listing.id }),
                });
                if (response.ok) {
                    loadAccount();
                    return;
                }
                const result = await response.json();
                window.alert(result.message || 'Could not delete that listing.');
            } catch {
                window.alert('Could not reach the server. Please try again.');
            }
            button.disabled = false;
        });
        return button;
    }

    function showAccount({ user, listings, orders, transportRequests }) {
        document.getElementById('account-intro').textContent =
            `Welcome, ${user.name}. Here is everything you have done on AgriLink.`;

        const details = [
            ['Name', user.name],
            ['Role', user.role.charAt(0).toUpperCase() + user.role.slice(1)],
            ['Email', user.email],
            ['Phone', user.phone],
            ['Location', user.location],
            ['Member since', formatDate(user.createdAt)],
        ].flatMap(([label, value]) => {
            const term = document.createElement('dt');
            term.textContent = label;
            const description = document.createElement('dd');
            description.textContent = value;
            return [term, description];
        });
        document.getElementById('profile-details').replaceChildren(...details);
        document.getElementById('profile').hidden = false;

        fillSection('my-listings', listings.map((listing) => makeCard(listing.product, [
            `Price: ZMW ${Number(listing.pricePerKg).toFixed(2)} per kg`,
            `Quantity: ${formatKg(listing.quantityKg)}`,
            `Location: ${listing.location}`,
            `Listed: ${formatDate(listing.createdAt)}`,
        ], deleteButton(listing))), user.role === 'farmer');

        fillSection('my-orders', orders.map((order) => makeCard(order.product, [
            `Quantity: ${formatKg(order.quantityKg)}`,
            `Delivery address: ${order.address}`,
            `Phone: ${order.phone}`,
            `Ordered: ${formatDate(order.createdAt)}`,
        ])), user.role === 'buyer');

        fillSection('my-transport', transportRequests.map((request) => makeCard(`${request.pickup} to ${request.destination}`, [
            `Produce: ${request.produce}`,
            `Weight: ${formatKg(request.weightKg)}`,
            `Delivery date: ${formatDay(request.date)}`,
            `Requested: ${formatDate(request.createdAt)}`,
        ])), user.role === 'transporter');
    }

    async function loadAccount() {
        const intro = document.getElementById('account-intro');
        try {
            const response = await fetch('/api/my-activity');
            if (response.status === 401) {
                const link = document.createElement('a');
                link.href = 'login.html';
                link.textContent = 'Log in here';
                intro.textContent = 'Please log in to see your account. ';
                intro.append(link, '.');
                return;
            }
            if (!response.ok) throw new Error('Request failed');
            showAccount(await response.json());
        } catch {
            intro.textContent = 'We could not load your account. Please try again.';
        }
    }

    if (document.getElementById('account-intro')) {
        loadAccount();
    }
})();
