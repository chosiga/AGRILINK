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
    document.querySelectorAll('input[name="harvestDate"]').forEach((input) => {
        input.removeAttribute('min');
    });

    /* ---------- Products: search, filter and sort ---------- */
    const filterForm = document.querySelector('main form[action="products.html"]');
    const searchForm = document.querySelector('header form[role="search"]');
    const searchInput = document.getElementById('site-search');
    const catalogSearchInput = document.getElementById('catalog-search');

    const categoryLabels = {
        maize: 'Maize',
        tomatoes: 'Tomatoes',
        groundnuts: 'Groundnuts',
        'soya-beans': 'Soya beans',
        vegetables: 'Vegetables',
        rice: 'Rice',
        fruits: 'Fruits',
        'fertilizers-and-farming-supplies': 'Fertilizers and farming supplies',
        'other-agricultural-products': 'Other agricultural products',
    };

    function listingImages(listing) {
        return Array.isArray(listing.imageUrls) && listing.imageUrls.length
            ? listing.imageUrls
            : ['/images/back.jpg'];
    }

    function readListingImage(file) {
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
            return Promise.reject(new Error('Product images must be JPEG, PNG, or WebP files.'));
        }
        if (file.size > 1024 * 1024) {
            return Promise.reject(new Error('Each product image must be 1 MB or smaller.'));
        }
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.addEventListener('load', () => {
                if (typeof reader.result === 'string') resolve(reader.result);
                else reject(new Error('A product image could not be read.'));
            });
            reader.addEventListener('error', () => reject(new Error('A product image could not be read.')));
            reader.readAsDataURL(file);
        });
    }

    async function apiFormPayload(form) {
        const formData = new FormData(form);
        const payload = Object.fromEntries(formData);
        const imageInput = form.querySelector('input[type="file"][name="imageFiles"]');
        if (imageInput) {
            const files = [...imageInput.files];
            if (files.length > 5) throw new Error('A listing can have at most 5 product images.');
            const totalBytes = files.reduce((total, file) => total + file.size, 0);
            if (totalBytes > 5 * 1024 * 1024) throw new Error('Product images must total 5 MB or less.');
            payload.imageFiles = await Promise.all(files.map(readListingImage));
        } else {
            delete payload.imageFiles;
        }
        if (typeof payload.images === 'string') {
            try {
                payload.images = JSON.parse(payload.images);
            } catch {
                throw new Error('The saved product image list is invalid. Reload the page and try again.');
            }
        }
        return payload;
    }

    function renderListing(listing) {
        const item = document.createElement('li');
        const card = document.createElement('article');
        card.className = 'market-listing-card';

        const imageLink = document.createElement('a');
        imageLink.className = 'market-listing-image-link';
        imageLink.href = `product.html?id=${encodeURIComponent(listing.id)}`;
        const image = document.createElement('img');
        image.src = listingImages(listing)[0];
        image.alt = `${listing.product} available from ${listing.farmerName}`;
        image.loading = 'lazy';
        imageLink.append(image);

        const content = document.createElement('div');
        content.className = 'market-listing-content';
        const title = document.createElement('h3');
        title.className = 'market-listing-title';
        title.textContent = listing.product; // textContent keeps farmers' text from being run as HTML

        const price = document.createElement('p');
        price.className = 'market-listing-price';
        price.textContent = `ZMW ${Number(listing.pricePerKg).toFixed(2)} / ${listing.unit}`;

        const details = [
            [`${Number(listing.quantityKg).toLocaleString('en-ZM')} ${listing.unit} available`, 'market-listing-quantity'],
            [`Minimum order: ${Number(listing.minimumOrderQuantity).toLocaleString('en-ZM')} ${listing.unit}`, 'market-listing-quantity'],
            [`${listing.location}, ${listing.province}`, 'market-listing-origin'],
        ].map(([line, className]) => {
            const paragraph = document.createElement('p');
            paragraph.className = className;
            paragraph.textContent = line;
            return paragraph;
        });

        const seller = document.createElement('p');
        seller.className = 'market-listing-origin';
        seller.append(document.createTextNode(listing.farmerName));
        if (listing.farmerVerified) {
            const badge = document.createElement('span');
            badge.className = 'verified-badge';
            badge.textContent = '✓ Verified';
            seller.append(' ', badge);
        }

        const rating = document.createElement('p');
        rating.className = 'market-listing-trust';
        rating.textContent = listing.farmerReviewCount
            ? `★ ${Number(listing.farmerRating).toFixed(1)} · ${listing.farmerReviewCount} review${listing.farmerReviewCount === 1 ? '' : 's'}`
            : 'No seller reviews yet';

        const summary = document.createElement('p');
        summary.className = 'market-listing-description';
        summary.textContent = listing.description;

        const harvest = document.createElement('p');
        harvest.className = 'market-listing-origin';
        harvest.textContent = listing.harvestDate ? `Harvested ${formatDay(listing.harvestDate)}` : 'Harvest date not provided';
        const delivery = document.createElement('span');
        delivery.className = `catalog-delivery ${listing.deliveryAvailable ? 'is-available' : ''}`;
        delivery.textContent = listing.deliveryAvailable ? 'Delivery available' : 'Collection by arrangement';

        const order = document.createElement('a');
        order.href = `product.html?id=${encodeURIComponent(listing.id)}`;
        order.textContent = 'View product';
        const availability = document.createElement('span');
        availability.className = 'catalog-availability';
        availability.textContent = listing.availabilityStatus === 'available' ? 'In stock' : 'Sold out';
        content.append(title, price, ...details, seller, rating, summary, harvest, delivery, availability, order);
        card.append(imageLink, content);
        item.append(card);
        return item;
    }

    function renderHomeListing(listing) {
        const item = document.createElement('li');
        const card = document.createElement('article');
        card.className = 'home-listing-card';

        const productName = listing.product.toLowerCase();
        const productImage = listingImages(listing)[0] || (productName.includes('tomato')
            ? 'images/pexels-cafer-sevi-nc-2150308909-34100648.jpg'
            : productName.includes('bean') || productName.includes('groundnut')
                ? 'images/pexels-adonyi-foto-5634204.jpg'
                : productName.includes('chicken') || productName.includes('poultry')
                    ? 'images/pexels-alistair-mockett-146505529-10444827.jpg'
                    : productName.includes('maize') || productName.includes('corn')
                        ? 'images/pexels-benjaminlehman-33902596.jpg'
                        : 'images/back.jpg');
        const image = document.createElement('img');
        image.src = productImage;
        image.alt = `${listing.product} listed for sale by ${listing.farmerName}`;
        image.loading = 'lazy';

        const content = document.createElement('div');
        content.className = 'home-listing-card-content';
        const heading = document.createElement('h3');
        heading.textContent = listing.product;
        const price = document.createElement('p');
        price.className = 'home-listing-price';
        price.textContent = `ZMW ${Number(listing.pricePerKg).toFixed(2)} / ${listing.unit}`;
        const quantity = document.createElement('p');
        quantity.className = 'home-listing-meta';
        quantity.textContent = `${Number(listing.quantityKg).toLocaleString('en-ZM')} ${listing.unit} available`;
        const origin = document.createElement('p');
        origin.className = 'home-listing-meta';
        origin.textContent = listing.location;
        const seller = document.createElement('p');
        seller.className = 'home-listing-seller';
        seller.append(document.createTextNode(listing.farmerName));
        if (listing.farmerVerified) {
            const badge = document.createElement('span');
            badge.className = 'verified-badge';
            badge.textContent = '✓ Verified';
            seller.append(badge);
        }
        const trust = document.createElement('p');
        trust.className = 'home-rating';
        trust.textContent = listing.farmerReviewCount > 0
            ? `★ ${Number(listing.farmerRating).toFixed(1)} · ${listing.farmerReviewCount} review${listing.farmerReviewCount === 1 ? '' : 's'}`
            : 'New seller';
        const order = document.createElement('a');
        order.href = `product.html?id=${encodeURIComponent(listing.id)}`;
        order.textContent = 'View product';

        content.append(heading, price, quantity, origin, seller, trust, order);
        card.append(image, content);
        item.append(card);
        return item;
    }

    async function showHomeListings() {
        const list = document.getElementById('home-listings');
        const status = document.getElementById('home-listings-status');
        if (!list || !status) return;

        try {
            const response = await fetch('/api/listings');
            if (!response.ok) throw new Error(`Listings could not be loaded (HTTP ${response.status}).`);
            const { listings } = await response.json();
            list.replaceChildren(...listings.slice(0, 4).map(renderHomeListing));
            status.textContent = listings.length
                ? `Showing ${Math.min(listings.length, 4)} of ${listings.length} current farmer listings.`
                : 'No produce is listed yet. Farmers can create the first listing after signing in.';
        } catch (error) {
            status.textContent = error instanceof Error
                ? `${error.message} Please try again later.`
                : 'Listings could not be loaded. Please try again later.';
        }
    }

    function renderHomeFarmer(farmer) {
        const item = document.createElement('li');
        const card = document.createElement('article');
        card.className = 'home-farmer-card';

        const name = document.createElement('h3');
        name.textContent = farmer.name;
        const location = document.createElement('p');
        location.textContent = farmer.location;
        const inventory = document.createElement('p');
        inventory.textContent = `${farmer.listings.length} active listing${farmer.listings.length === 1 ? '' : 's'}`;
        card.append(name, location, inventory);

        if (farmer.verified) {
            const badge = document.createElement('span');
            badge.className = 'verified-badge';
            badge.textContent = '✓ Verified farmer';
            card.append(badge);
        }
        if (farmer.reviewCount > 0) {
            const rating = document.createElement('p');
            rating.className = 'home-rating';
            rating.textContent = `★ ${Number(farmer.rating).toFixed(1)} · ${farmer.reviewCount} review${farmer.reviewCount === 1 ? '' : 's'}`;
            card.append(rating);
        }

        const link = document.createElement('a');
        link.href = 'farmers.html#featured-farmers';
        link.textContent = 'View farmer directory';
        card.append(link);
        item.append(card);
        return item;
    }

    async function showHomeFarmers() {
        const list = document.getElementById('home-farmers');
        const status = document.getElementById('home-farmers-status');
        if (!list || !status) return;

        try {
            const response = await fetch('/api/farmers');
            if (!response.ok) throw new Error(`Farmer profiles could not be loaded (HTTP ${response.status}).`);
            const { farmers } = await response.json();
            const verified = farmers.filter((farmer) => farmer.verified);
            const featured = (verified.length ? verified : farmers).slice(0, 3);
            list.replaceChildren(...featured.map(renderHomeFarmer));
            status.textContent = verified.length
                ? `${verified.length} verified farmer${verified.length === 1 ? '' : 's'} are on AgriLink.`
                : farmers.length
                    ? 'Farmer profiles are shown below. Verification badges appear only after an admin review.'
                    : 'Farmer profiles will appear here after growers join AgriLink.';
        } catch (error) {
            status.textContent = error instanceof Error
                ? `${error.message} Please try again later.`
                : 'Farmer profiles could not be loaded. Please try again later.';
        }
    }

    if (document.getElementById('home-listings')) {
        showHomeListings();
        showHomeFarmers();
    }

    async function loadProductDetail() {
        const panel = document.getElementById('product-detail');
        if (!panel) return;
        const status = document.getElementById('product-detail-status');
        const id = new URLSearchParams(window.location.search).get('id');
        if (!id) {
            status.textContent = 'Choose a product from the marketplace to see its details.';
            return;
        }

        try {
            const response = await fetch(`/api/listing?id=${encodeURIComponent(id)}`);
            const result = await response.json();
            if (!response.ok) throw new Error(result.message || 'This product could not be found.');
            const { listing, reviews } = result;
            const images = listingImages(listing);
            const mainImage = document.getElementById('product-main-image');
            const thumbnails = document.getElementById('product-thumbnails');
            mainImage.src = images[0];
            mainImage.alt = `${listing.product} from ${listing.farmerName}`;
            thumbnails.replaceChildren(...images.map((src, index) => {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'product-thumbnail';
                button.setAttribute('aria-label', `Show product image ${index + 1}`);
                button.setAttribute('aria-pressed', index === 0 ? 'true' : 'false');
                const image = document.createElement('img');
                image.src = src;
                image.alt = '';
                image.loading = 'lazy';
                button.append(image);
                button.addEventListener('click', () => {
                    mainImage.src = src;
                    mainImage.alt = `${listing.product}, image ${index + 1}`;
                    thumbnails.querySelectorAll('button').forEach((other) => {
                        other.setAttribute('aria-pressed', String(other === button));
                    });
                });
                return button;
            }));

            document.title = `${listing.product} | AgriLink Zambia`;
            document.getElementById('product-category').textContent = categoryLabels[listing.category] || 'Agricultural products';
            document.getElementById('product-title').textContent = listing.product;
            document.getElementById('product-price').textContent =
                `ZMW ${Number(listing.pricePerKg).toFixed(2)} / ${listing.unit}`;
            document.getElementById('product-description').textContent = listing.description;
            document.getElementById('product-harvest').textContent = listing.harvestDate
                ? `Harvested on ${formatDay(listing.harvestDate)}`
                : 'Harvest date not provided by seller.';
            document.getElementById('product-delivery').textContent = listing.deliveryAvailable
                ? 'Delivery is available. Confirm delivery terms with the seller.'
                : 'Collection from the farm or collection point. Ask the seller about delivery.';

            const facts = document.getElementById('product-facts');
            const factPairs = [
                ['Available quantity', `${Number(listing.quantityKg).toLocaleString('en-ZM')} ${listing.unit}`],
                ['Minimum order', `${Number(listing.minimumOrderQuantity).toLocaleString('en-ZM')} ${listing.unit}`],
                ['Farm / collection location', `${listing.location}, ${listing.province}`],
                ['Availability', listing.availabilityStatus === 'available' ? 'Available to order' : 'Sold out'],
            ];
            facts.replaceChildren(...factPairs.flatMap(([label, value]) => {
                const term = document.createElement('dt');
                term.textContent = label;
                const detail = document.createElement('dd');
                detail.textContent = value;
                return [term, detail];
            }));
            document.getElementById('product-availability').textContent = listing.availabilityStatus === 'available'
                ? 'In stock'
                : 'Currently sold out';
            const purchaseLink = document.getElementById('product-buy-link');
            purchaseLink.href = `buyers.html?listing=${encodeURIComponent(listing.id)}#place-order`;
            purchaseLink.textContent = listing.availabilityStatus === 'available' ? 'Order from this farmer' : 'Browse other products';
            if (listing.availabilityStatus !== 'available') purchaseLink.href = 'products.html';

            document.getElementById('seller-name').textContent = listing.farmerName;
            document.getElementById('seller-location').textContent = `${listing.location}, ${listing.province}`;
            const sellerTrust = document.getElementById('seller-trust');
            sellerTrust.textContent = listing.farmerVerified ? '✓ Verified AgriLink farmer' : 'AgriLink farmer';
            if (listing.farmerReviewCount > 0) {
                document.getElementById('product-rating').textContent =
                    `★ ${Number(listing.farmerRating).toFixed(1)} · ${listing.farmerReviewCount} verified-purchase review${listing.farmerReviewCount === 1 ? '' : 's'}`;
            } else {
                document.getElementById('product-rating').textContent = 'No buyer reviews yet';
            }

            const reviewList = document.getElementById('product-reviews-list');
            reviewList.replaceChildren(...reviews.map((review) => {
                const item = document.createElement('li');
                const card = document.createElement('article');
                const title = document.createElement('h3');
                title.textContent = `★ ${review.rating} · ${review.buyerName}`;
                const date = document.createElement('time');
                date.dateTime = review.createdAt;
                date.textContent = formatDate(review.createdAt);
                const comment = document.createElement('p');
                comment.textContent = review.comment || 'This buyer left a rating without a written comment.';
                card.append(title, date, comment);
                item.append(card);
                return item;
            }));
            document.getElementById('reviews-summary').textContent = reviews.length
                ? `${reviews.length} recent verified-purchase review${reviews.length === 1 ? '' : 's'}`
                : 'Reviews are available after buyers confirm delivery of an order.';
            panel.hidden = false;
            status.textContent = '';
        } catch (error) {
            status.textContent = error instanceof Error
                ? `${error.message} Browse the marketplace for available products.`
                : 'Product details could not be loaded.';
        }
    }

    if (document.getElementById('product-detail')) {
        loadProductDetail();
    }

    async function showFarmerListings() {
        const list = document.querySelector('#farmer-listings ul');
        if (!list) return;
        try {
            const response = await fetch('/api/listings');
            if (!response.ok) return;
            const { listings } = await response.json();
            list.replaceChildren(...listings.map(renderListing));
            document.getElementById('farmer-listings').hidden = listings.length === 0;
        } catch {
            // No server: the page simply shows the example products
        }
    }

    function renderFarmerProfile(farmer) {
        const item = document.createElement('li');
        const card = document.createElement('article');
        card.className = 'farmer-profile-card';

        const header = document.createElement('header');
        header.className = 'farmer-profile-header';

        const initials = farmer.name
            .trim()
            .split(/\s+/)
            .slice(0, 2)
            .map((part) => part.charAt(0).toUpperCase())
            .join('');
        const avatar = document.createElement('span');
        avatar.className = 'farmer-profile-avatar';
        avatar.setAttribute('aria-hidden', 'true');
        avatar.textContent = initials || '?';

        const identity = document.createElement('div');
        const name = document.createElement('h3');
        name.textContent = farmer.name;
        const location = document.createElement('p');
        location.className = 'farmer-profile-location';
        location.textContent = farmer.location;
        identity.append(name, location);
        if (farmer.verified) {
            const badge = document.createElement('span');
            badge.className = 'verified-badge';
            badge.textContent = '✓ Verified farmer';
            identity.append(badge);
        }
        if (farmer.reviewCount > 0) {
            const rating = document.createElement('p');
            rating.className = 'home-rating';
            rating.textContent = `★ ${Number(farmer.rating).toFixed(1)} · ${farmer.reviewCount} review${farmer.reviewCount === 1 ? '' : 's'}`;
            identity.append(rating);
        }
        header.append(avatar, identity);

        const productsHeading = document.createElement('h4');
        productsHeading.textContent = `Available products (${farmer.listings.length})`;
        const products = document.createElement('ul');
        products.className = 'farmer-products';

        farmer.listings.forEach((listing) => {
            const productItem = document.createElement('li');
            const product = document.createElement('article');
            product.className = 'farmer-product';

            const productName = document.createElement('h4');
            productName.textContent = listing.product;
            const price = document.createElement('p');
            price.className = 'farmer-product-price';
            price.textContent = `ZMW ${Number(listing.pricePerKg).toFixed(2)} / ${listing.unit || 'kg'}`;
            const quantity = document.createElement('p');
            quantity.className = 'farmer-product-quantity';
            quantity.textContent = `${formatQuantity(listing.quantityKg, listing.unit || 'kg')} available`;

            const order = document.createElement('a');
            order.href = `buyers.html?listing=${encodeURIComponent(listing.id)}#place-order`;
            order.textContent = 'View product';
            product.append(productName, price, quantity, order);
            productItem.append(product);
            products.append(productItem);
        });

        if (farmer.listings.length === 0) {
            const emptyItem = document.createElement('li');
            emptyItem.className = 'farmer-products-empty';
            emptyItem.textContent = 'No products listed yet.';
            products.append(emptyItem);
        }

        card.append(header, productsHeading, products);
        item.append(card);
        return item;
    }

    async function showFarmerProfiles() {
        const list = document.getElementById('farmer-directory');
        const status = document.getElementById('farmer-directory-status');
        if (!list || !status) return;

        try {
            const response = await fetch('/api/farmers');
            if (!response.ok) {
                throw new Error(`Farmer profiles could not be loaded (HTTP ${response.status}).`);
            }
            const { farmers } = await response.json();
            list.replaceChildren(...farmers.map(renderFarmerProfile));
            status.textContent = farmers.length
                ? `${farmers.length} registered farmer profile${farmers.length === 1 ? '' : 's'}. Profiles update from farmers' account details and active listings.`
                : 'No farmer profiles yet. Farmer profiles appear here after they register.';
        } catch (error) {
            status.textContent = error instanceof Error
                ? `${error.message} Please try again later.`
                : 'Farmer profiles could not be loaded. Please try again later.';
        }
    }

    if (document.getElementById('farmer-directory')) {
        showFarmerProfiles();
    }

    async function initProducts() {
        const list = document.getElementById('catalog-listings');
        const status = document.getElementById('catalog-status');
        const empty = document.getElementById('catalog-empty');
        const pagination = document.getElementById('catalog-pagination');
        const pageStatus = document.getElementById('catalog-page-status');
        const pageParams = new URLSearchParams(window.location.search);
        let page = Math.max(1, Number(pageParams.get('page')) || 1);
        let totalPages = 1;
        let searchTimer;

        const fields = ['q', 'category', 'priceMin', 'priceMax', 'province', 'quantityMin', 'quantityMax', 'minRating'];
        fields.forEach((name) => {
            const field = filterForm.elements.namedItem(name);
            const value = pageParams.get(name);
            if (field && value !== null) field.value = value;
        });
        ['verified', 'delivery'].forEach((name) => {
            const field = filterForm.elements.namedItem(name);
            field.checked = pageParams.get(name) === 'true';
        });
        const sortSelect = document.getElementById('sort');
        sortSelect.value = pageParams.get('sort') || 'newest';

        const queryFromForm = () => {
            const params = new URLSearchParams();
            new FormData(filterForm).forEach((value, name) => {
                if (typeof value === 'string' && value.trim()) params.set(name, value.trim());
            });
            params.set('sort', sortSelect.value);
            params.set('page', String(page));
            params.set('pageSize', '12');
            return params;
        };

        const loadPage = async ({ resetPage = false, updateUrl = true } = {}) => {
            if (resetPage) page = 1;
            const params = queryFromForm();
            if (updateUrl) {
                const query = params.toString();
                window.history.replaceState({}, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
            }
            status.textContent = 'Loading products…';
            empty.hidden = true;
            pagination.hidden = true;
            try {
                const response = await fetch(`/api/listings?${params}`);
                const result = await response.json();
                if (!response.ok) throw new Error(result.message || 'Products could not be loaded.');
                list.replaceChildren(...result.listings.map(renderListing));
                totalPages = Math.max(1, result.pagination.totalPages);
                page = result.pagination.page;
                status.textContent = result.pagination.total
                    ? `${result.pagination.total.toLocaleString('en-ZM')} listing${result.pagination.total === 1 ? '' : 's'} found`
                    : 'No products match your current search and filters.';
                empty.hidden = result.pagination.total !== 0;
                pagination.hidden = result.pagination.totalPages <= 1;
                pageStatus.textContent = `Page ${page} of ${totalPages}`;
                document.getElementById('catalog-previous').disabled = page <= 1;
                document.getElementById('catalog-next').disabled = page >= totalPages;
            } catch (error) {
                list.replaceChildren();
                empty.hidden = true;
                status.textContent = error instanceof Error
                    ? `${error.message} Please try again.`
                    : 'Products could not be loaded. Please try again.';
            }
        };

        const scheduleSearch = () => {
            window.clearTimeout(searchTimer);
            searchTimer = window.setTimeout(() => loadPage({ resetPage: true }), 250);
        };
        filterForm.addEventListener('submit', (event) => {
            event.preventDefault();
            loadPage({ resetPage: true });
        });
        filterForm.addEventListener('input', scheduleSearch);
        filterForm.addEventListener('change', scheduleSearch);
        sortSelect.addEventListener('change', () => loadPage({ resetPage: true }));
        if (searchInput) {
            searchInput.value = filterForm.elements.namedItem('q').value;
            searchInput.addEventListener('input', () => {
                filterForm.elements.namedItem('q').value = searchInput.value;
                scheduleSearch();
            });
            searchForm.addEventListener('submit', (event) => {
                event.preventDefault();
                filterForm.elements.namedItem('q').value = searchInput.value;
                loadPage({ resetPage: true });
            });
        }
        const clearFilters = () => {
            filterForm.reset();
            if (searchInput) searchInput.value = '';
            sortSelect.value = 'newest';
            loadPage({ resetPage: true });
        };
        document.getElementById('clear-catalog-filters').addEventListener('click', clearFilters);
        document.getElementById('catalog-empty-clear').addEventListener('click', clearFilters);
        document.getElementById('catalog-previous').addEventListener('click', () => {
            if (page > 1) {
                page--;
                loadPage();
            }
        });
        document.getElementById('catalog-next').addEventListener('click', () => {
            if (page < totalPages) {
                page++;
                loadPage();
            }
        });
        await loadPage({ updateUrl: false });
    }

    if (filterForm && searchInput) {
        initProducts();
    }

    async function initBuyerOrder() {
        const form = document.querySelector('#place-order form[action="/api/orders"]');
        if (!form) return;
        const params = new URLSearchParams(window.location.search);
        const suggestedProduct = params.get('product');
        const productInput = document.getElementById('buyer-product');
        if (suggestedProduct && suggestedProduct.length <= 100) productInput.value = suggestedProduct;
        const listingId = params.get('listing');
        if (!listingId) return;

        const status = document.getElementById('listing-summary');
        try {
            const response = await fetch(`/api/listing?id=${encodeURIComponent(listingId)}`);
            const result = await response.json();
            if (!response.ok) throw new Error(result.message || 'This listing could not be loaded.');
            const { listing } = result;
            document.getElementById('listing-id').value = listing.id;
            const product = document.getElementById('buyer-product');
            product.value = listing.product;
            product.readOnly = true;
            const quantity = document.getElementById('buyer-quantity');
            quantity.min = String(listing.minimumOrderQuantity);
            quantity.max = String(listing.quantityKg);
            quantity.step = '0.01';
            quantity.value = String(listing.minimumOrderQuantity);
            const quantityLabel = document.querySelector('label[for="buyer-quantity"]');
            quantityLabel.textContent = `Quantity (${listing.unit})`;
            status.textContent = `${listing.product} · ZMW ${Number(listing.pricePerKg).toFixed(2)} / ${listing.unit} · ${Number(listing.quantityKg).toLocaleString('en-ZM')} ${listing.unit} available · minimum ${Number(listing.minimumOrderQuantity).toLocaleString('en-ZM')} ${listing.unit}`;
            status.hidden = false;
            if (listing.availabilityStatus !== 'available') {
                status.textContent = `${listing.product} is currently sold out. Browse the marketplace for other products.`;
                form.querySelector('button[type="submit"]').disabled = true;
                const browseLink = document.createElement('a');
                browseLink.href = 'products.html';
                browseLink.textContent = 'Browse available products';
                status.append(' ', browseLink);
            }
        } catch (error) {
            status.hidden = false;
            status.textContent = error instanceof Error
                ? `${error.message} You can still submit a general product request below.`
                : 'Listing details could not be loaded. You can still submit a general product request below.';
            document.getElementById('listing-id').value = '';
        }
    }

    initBuyerOrder();

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
                    body: JSON.stringify(await apiFormPayload(form)),
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
            } catch (error) {
                show(error instanceof Error ? error.message : 'Could not reach the server. Please try again.', 'error');
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
            .then(({ user, unread }) => {
                if (!user) return;

                const greeting = document.createElement('li');
                const name = document.createElement('a');
                name.href = 'account.html';
                name.textContent = `Hi, ${user.name.split(' ')[0]}`; // textContent keeps names safe from HTML injection
                if (window.location.pathname.endsWith('account.html')) name.setAttribute('aria-current', 'page');
                if (unread > 0 && !window.location.pathname.endsWith('account.html')) {
                    const first = user.name.split(' ')[0];
                    name.setAttribute('aria-label', `Hi, ${first}, ${unread} new notification${unread === 1 ? '' : 's'}`);
                    const badge = document.createElement('span');
                    badge.dataset.badge = '';
                    badge.setAttribute('aria-hidden', 'true'); // the link's label already says it
                    badge.textContent = unread;
                    name.append(badge);
                }
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
    const formatQuantity = (value, unit = 'kg') => `${Number(value).toLocaleString('en-GB')} ${unit}`;
    const formatKg = (value) => formatQuantity(value);
    const paymentPreference = (order) => {
        if (order.paymentMethod === 'paypal') return 'PayPal';
        if (order.paymentMethod !== 'mobile_money') return 'Not recorded';
        const providers = { mtn: 'MTN', airtel: 'Airtel', zamtel: 'Zamtel Kwacha' };
        return `Mobile Money${order.mobileMoneyProvider ? ` (${providers[order.mobileMoneyProvider] || order.mobileMoneyProvider})` : ''}`;
    };

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
        button.dataset.variant = 'delete';
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

    function editButton(listing) {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.variant = 'edit';
        button.textContent = 'Edit';
        button.addEventListener('click', () => {
            const form = document.getElementById('edit-listing-form');
            form.elements.namedItem('id').value = listing.id;
            form.elements.namedItem('location').value = listing.location;
            form.elements.namedItem('province').value = listing.province;
            form.elements.namedItem('category').value = listing.category;
            form.elements.namedItem('description').value = listing.description;
            form.elements.namedItem('unit').value = listing.unit;
            form.elements.namedItem('quantity').value = listing.quantityKg;
            form.elements.namedItem('minimumOrder').value = listing.minimumOrderQuantity;
            form.elements.namedItem('price').value = listing.pricePerKg;
            form.elements.namedItem('harvestDate').value = listing.harvestDate || '';
            form.elements.namedItem('deliveryAvailable').checked = listing.deliveryAvailable;
            form.elements.namedItem('images').value = JSON.stringify(listingImages(listing));
            form.elements.namedItem('imageFiles').value = '';
            document.getElementById('edit-product').textContent = `Product: ${listing.product}`;
            const imageList = document.getElementById('edit-current-images');
            imageList.replaceChildren();
            const imagePaths = listingImages(listing).slice();
            const imageLabel = document.createElement('span');
            imageLabel.textContent = 'Current images. Uncheck an image to remove it:';
            imageList.append(imageLabel);
            imagePaths.forEach((imagePath, index) => {
                const label = document.createElement('label');
                label.className = 'edit-image-choice';
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.checked = true;
                checkbox.setAttribute('aria-label', `Keep image ${index + 1}`);
                const preview = document.createElement('img');
                preview.src = imagePath;
                preview.alt = `Current product image ${index + 1}`;
                checkbox.addEventListener('change', () => {
                    const remaining = [...imageList.querySelectorAll('input[type="checkbox"]:checked')]
                        .map((choice) => choice.dataset.image);
                    form.elements.namedItem('images').value = JSON.stringify(remaining);
                });
                checkbox.dataset.image = imagePath;
                label.append(checkbox, preview);
                imageList.append(label);
            });
            document.getElementById('edit-message').textContent = '';
            document.getElementById('edit-listing').showModal();
        });
        return button;
    }

    function listingActions(listing) {
        const group = document.createElement('div');
        group.setAttribute('role', 'group');
        group.setAttribute('aria-label', `Manage the listing for ${listing.product}`);
        group.append(editButton(listing), deleteButton(listing));
        return group;
    }

    const editDialog = document.getElementById('edit-listing');
    if (editDialog) {
        const editForm = document.getElementById('edit-listing-form');
        const editMessage = document.getElementById('edit-message');

        document.getElementById('edit-cancel').addEventListener('click', () => editDialog.close());

        editForm.addEventListener('submit', async (event) => {
            event.preventDefault();
            const saveButton = editForm.querySelector('button[type="submit"]');
            saveButton.disabled = true;
            editMessage.textContent = '';
            delete editMessage.dataset.state;

            try {
                const response = await fetch('/api/listings/update', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(await apiFormPayload(editForm)),
                });
                const result = await response.json();
                if (response.ok) {
                    editDialog.close();
                    loadAccount();
                } else {
                    editMessage.textContent = result.message || 'Could not save your changes.';
                    editMessage.dataset.state = 'error';
                }
            } catch (error) {
                editMessage.textContent = error instanceof Error ? error.message : 'Could not reach the server. Please try again.';
                editMessage.dataset.state = 'error';
            } finally {
                saveButton.disabled = false;
            }
        });
    }

    const buyerStatus = {
        pending: 'Waiting for the farmer to respond',
        accepted: 'Accepted by the farmer',
        declined: 'Declined by the farmer',
        cancelled: 'Cancelled because the listing was removed',
        open: 'General request (no farmer chosen)',
    };

    const farmerStatus = {
        pending: 'Waiting for your response',
        accepted: 'You accepted this order',
        declined: 'You declined this order',
        cancelled: 'Cancelled because the listing was removed',
    };

    function respondButtons(order) {
        const group = document.createElement('div');
        group.setAttribute('role', 'group');
        group.setAttribute('aria-label', `Respond to the order for ${order.product}`);

        [['accept', 'Accept'], ['decline', 'Decline']].forEach(([decision, label]) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = label;
            button.dataset.variant = decision;
            button.addEventListener('click', async () => {
                const question = `${label} the order for ${formatQuantity(order.quantityKg, order.unit)} of ${order.product} from ${order.buyerName}?`;
                if (!window.confirm(question)) return;
                group.querySelectorAll('button').forEach((each) => { each.disabled = true; });
                try {
                    const response = await fetch('/api/orders/respond', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ id: order.id, decision }),
                    });
                    if (response.ok) {
                        loadAccount();
                        return;
                    }
                    const result = await response.json();
                    window.alert(result.message || 'Something went wrong.');
                } catch {
                    window.alert('Could not reach the server. Please try again.');
                }
                group.querySelectorAll('button').forEach((each) => { each.disabled = false; });
            });
            group.append(button);
        });
        return group;
    }

    function confirmDeliveryButton(order) {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.variant = 'accept';
        button.textContent = 'Confirm delivery';
        button.addEventListener('click', async () => {
            if (!window.confirm(`Confirm that ${order.product} has been delivered?`)) return;
            button.disabled = true;
            try {
                const response = await fetch('/api/orders/confirm-delivery', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id: order.id }),
                });
                const result = await response.json();
                if (!response.ok) throw new Error(result.message || 'Could not confirm delivery.');
                loadAccount();
            } catch (error) {
                window.alert(error instanceof Error ? error.message : 'Could not reach the server.');
                button.disabled = false;
            }
        });
        return button;
    }

    function reviewForm(order) {
        const form = document.createElement('form');
        form.className = 'farmer-review-form';
        form.action = '/api/orders/review';
        form.method = 'post';

        const orderId = document.createElement('input');
        orderId.type = 'hidden';
        orderId.name = 'orderId';
        orderId.value = order.id;

        const ratingLabel = document.createElement('label');
        ratingLabel.textContent = 'Rate your farmer';
        const rating = document.createElement('select');
        rating.name = 'rating';
        rating.required = true;
        [['', 'Choose a rating'], ['5', '5 — Excellent'], ['4', '4 — Good'], ['3', '3 — Average'], ['2', '2 — Poor'], ['1', '1 — Very poor']]
            .forEach(([value, label]) => {
                const option = document.createElement('option');
                option.value = value;
                option.textContent = label;
                rating.append(option);
            });
        ratingLabel.append(rating);

        const commentLabel = document.createElement('label');
        commentLabel.textContent = 'Review (optional)';
        const comment = document.createElement('textarea');
        comment.name = 'comment';
        comment.maxLength = 1000;
        comment.rows = 3;
        commentLabel.append(comment);

        const message = document.createElement('p');
        message.setAttribute('role', 'status');
        const submit = document.createElement('button');
        submit.type = 'submit';
        submit.textContent = 'Submit review';
        form.append(orderId, ratingLabel, commentLabel, message, submit);
        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            submit.disabled = true;
            message.textContent = '';
            try {
                const response = await fetch(form.action, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(Object.fromEntries(new FormData(form))),
                });
                const result = await response.json();
                if (!response.ok) throw new Error(result.message || 'Could not submit your review.');
                loadAccount();
            } catch (error) {
                message.textContent = error instanceof Error ? error.message : 'Could not reach the server.';
                message.dataset.state = 'error';
                submit.disabled = false;
            }
        });
        return form;
    }

    async function loadAdminDashboard() {
        const dashboard = document.getElementById('admin-dashboard');
        const status = document.getElementById('admin-farmers-status');
        const list = document.getElementById('admin-farmers');
        if (!dashboard || !status || !list) return;
        dashboard.hidden = false;
        status.textContent = 'Loading farmer accounts…';

        try {
            const response = await fetch('/api/admin/overview');
            const result = await response.json();
            if (!response.ok) throw new Error(result.message || 'Admin overview could not be loaded.');
            const metrics = document.getElementById('admin-metrics');
            const metricNodes = Object.entries({
                'Registered accounts': result.counts.users,
                'Active listings': result.counts.activeListings,
                'Orders': result.counts.orders,
                'Transport requests': result.counts.transportRequests,
                'Farmers awaiting verification': result.counts.unverifiedFarmers,
            }).flatMap(([label, value]) => {
                const term = document.createElement('dt');
                term.textContent = label;
                const description = document.createElement('dd');
                description.textContent = Number(value).toLocaleString('en-ZM');
                return [term, description];
            });
            metrics.replaceChildren(...metricNodes);

            list.replaceChildren(...result.farmers.map((farmer) => {
                const item = document.createElement('li');
                const card = document.createElement('article');
                const name = document.createElement('h4');
                name.textContent = farmer.name;
                const details = document.createElement('p');
                details.textContent = `${farmer.email} · ${farmer.location} · ${farmer.activeListings} active listings`;
                const state = document.createElement('p');
                state.textContent = farmer.verified ? 'Verified farmer' : 'Verification pending';
                const button = document.createElement('button');
                button.type = 'button';
                button.dataset.variant = farmer.verified ? 'delete' : 'accept';
                button.textContent = farmer.verified ? 'Remove verification' : 'Verify farmer';
                button.addEventListener('click', async () => {
                    button.disabled = true;
                    try {
                        const update = await fetch('/api/admin/farmers/verify', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ id: farmer.id, verified: !farmer.verified }),
                        });
                        const updateResult = await update.json();
                        if (!update.ok) throw new Error(updateResult.message || 'Could not update verification.');
                        loadAdminDashboard();
                    } catch (error) {
                        window.alert(error instanceof Error ? error.message : 'Could not reach the server.');
                        button.disabled = false;
                    }
                });
                card.append(name, details, state, button);
                item.append(card);
                return item;
            }));
            status.textContent = result.farmers.length
                ? `Showing ${result.farmers.length} farmer accounts.`
                : 'No farmer accounts are registered yet.';
        } catch (error) {
            status.textContent = error instanceof Error ? error.message : 'Admin overview could not be loaded.';
        }
    }

    const transportStatus = {
        open: 'Waiting for a transporter',
        accepted: 'Accepted by a transporter',
        delivered: 'Delivered',
        cancelled: 'Cancelled',
    };

    // One button that asks "are you sure?", tells the server, then refreshes the page's data
    function jobButton(label, variant, url, job, question) {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.variant = variant;
        button.textContent = label;
        button.addEventListener('click', async () => {
            if (!window.confirm(question)) return;
            button.disabled = true;
            try {
                const response = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id: job.id }),
                });
                if (!response.ok) {
                    const result = await response.json();
                    window.alert(result.message || 'Something went wrong.');
                }
                loadAccount(); // show the latest state either way (another person may have changed it)
            } catch {
                window.alert('Could not reach the server. Please try again.');
                button.disabled = false;
            }
        });
        return button;
    }

    const routeTitle = (job) => `${job.pickup} to ${job.destination}`;

    function jobLines(job) {
        return [
            `Produce: ${job.produce}`,
            `Weight: ${formatKg(job.weightKg)}`,
            `Delivery date: ${formatDay(job.date)}`,
        ];
    }

    let notificationsMarkedRead = false;

    function showNotifications(notifications) {
        const section = document.getElementById('notifications');
        const items = notifications.map((note) => {
            const item = document.createElement('li');
            if (!note.read) {
                item.dataset.unread = '';
                const label = document.createElement('span');
                label.textContent = 'New'; // words as well as colour, so it is clear to everyone
                item.append(label);
            }
            const link = document.createElement('a');
            link.href = note.link;
            link.textContent = note.message; // textContent keeps people's names safe from HTML injection
            const time = document.createElement('time');
            time.dateTime = note.createdAt;
            time.textContent = formatDate(note.createdAt);
            item.append(link, time);
            return item;
        });
        section.querySelector('ul').replaceChildren(...items);
        section.querySelector('[data-empty]').hidden = items.length > 0;
        section.hidden = false;

        // Now that they have been shown, they count as read (once per visit)
        if (!notificationsMarkedRead && notifications.some((note) => !note.read)) {
            notificationsMarkedRead = true;
            fetch('/api/notifications/read', { method: 'POST' }).catch(() => {});
        }
    }

    function showAccount({ user, listings, orders, ordersReceived, transportRequests, jobsAvailable, myJobs, notifications }) {
        document.getElementById('account-intro').textContent =
            `Welcome, ${user.name}. Here is everything you have done on AgriLink.`;
        const adminDashboard = document.getElementById('admin-dashboard');
        if (adminDashboard) {
            adminDashboard.hidden = user.role !== 'admin';
            if (user.role === 'admin') loadAdminDashboard();
        }

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
        showNotifications(notifications || []);
        document.getElementById('profile-details').replaceChildren(...details);
        document.getElementById('profile').hidden = false;

        fillSection('my-listings', listings.map((listing) => makeCard(listing.product, [
            `Price: ZMW ${Number(listing.pricePerKg).toFixed(2)} per ${listing.unit}`,
            `Quantity: ${formatQuantity(listing.quantityKg, listing.unit)}`,
            `Minimum order: ${formatQuantity(listing.minimumOrderQuantity, listing.unit)}`,
            `Location: ${listing.location}`,
            `Listed: ${formatDate(listing.createdAt)}`,
        ], listingActions(listing))), user.role === 'farmer');

        fillSection('orders-received', ordersReceived.map((order) => {
            const lines = [
                `Buyer: ${order.buyerName}`,
                `Phone: ${order.phone}`,
                `Quantity: ${formatQuantity(order.quantityKg, order.unit)}`,
                `Payment preference: ${paymentPreference(order)}`,
                `Delivery address: ${order.address}`,
                `Ordered: ${formatDate(order.createdAt)}`,
                `Status: ${farmerStatus[order.status] || order.status}`,
            ];
            if (order.deliveryRequestId) lines.push('Delivery: requested');
            const action = order.status === 'pending'
                ? respondButtons(order)
                : order.status === 'accepted' && !order.deliveryRequestId
                    ? requestTransportLink(order)
                    : null;
            return makeCard(order.product, lines, action);
        }), user.role === 'farmer');

        fillSection('my-orders', orders.map((order) => {
            const lines = [`Quantity: ${formatQuantity(order.quantityKg, order.unit)}`];
            if (order.sellerName) {
                lines.push(`Farmer: ${order.sellerName}, ${order.sellerLocation}`);
                lines.push(`Estimated total: ZMW ${(order.quantityKg * order.pricePerKg).toFixed(2)} (ZMW ${Number(order.pricePerKg).toFixed(2)} per ${order.unit})`);
            }
            lines.push(`Payment preference: ${paymentPreference(order)}`);
            lines.push(`Delivery address: ${order.address}`);
            if (order.sellerPhone) lines.push(`Farmer's phone: ${order.sellerPhone}`);
            lines.push(`Ordered: ${formatDate(order.createdAt)}`);
            lines.push(`Status: ${buyerStatus[order.status] || order.status}`);
            if (order.deliveryStatus && order.deliveryStatus !== 'not_requested') {
                lines.push(`Delivery: ${transportStatus[order.deliveryStatus] || order.deliveryStatus}`);
            }
            let action = null;
            if (order.deliveryStatus === 'delivered') {
                action = confirmDeliveryButton(order);
            } else if (order.deliveryStatus === 'confirmed' && order.sellerName && !order.reviewed) {
                action = reviewForm(order);
            } else if (order.reviewed) {
                lines.push('Review: submitted');
            }
            if (!action && order.status === 'accepted' && !order.deliveryRequestId) {
                action = requestTransportLink(order);
            }
            return makeCard(order.product, lines, action);
        }), user.role === 'buyer');

        fillSection('jobs-available', jobsAvailable.map((job) => makeCard(
            routeTitle(job),
            [...jobLines(job), `Posted: ${formatDate(job.createdAt)}`],
            jobButton('Accept job', 'accept', '/api/transport-requests/accept', job,
                `Accept the delivery of ${job.produce} from ${job.pickup} to ${job.destination}?`)
        )), user.role === 'transporter');

        fillSection('my-jobs', myJobs.map((job) => {
            const lines = [
                ...jobLines(job),
                `Requested by: ${job.requesterName}`,
                `Phone: ${job.requesterPhone}`,
                `Status: ${transportStatus[job.status] || job.status}`,
            ];
            const action = job.status === 'accepted'
                ? jobButton('Mark as delivered', 'accept', '/api/transport-requests/deliver', job,
                    `Mark the delivery from ${job.pickup} to ${job.destination} as delivered?`)
                : null;
            return makeCard(routeTitle(job), lines, action);
        }), false);

        fillSection('my-transport', transportRequests.map((request) => {
            const lines = [...jobLines(request), `Requested: ${formatDate(request.createdAt)}`];
            if (request.status === 'accepted' || request.status === 'delivered') {
                const verb = request.status === 'delivered' ? 'Delivered' : 'Accepted';
                lines.push(`Status: ${verb} by ${request.transporterName}`);
                if (request.transporterPhone) lines.push(`Transporter's phone: ${request.transporterPhone}`);
            } else {
                lines.push(`Status: ${transportStatus[request.status] || request.status}`);
            }
            const action = request.status === 'open'
                ? jobButton('Cancel request', 'delete', '/api/transport-requests/cancel', request,
                    `Cancel your request to move ${request.produce} from ${request.pickup} to ${request.destination}?`)
                : null;
            return makeCard(routeTitle(request), lines, action);
        }), false);
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
            const activity = await response.json();
            showAccount(activity);
            const params = new URLSearchParams(window.location.search);
            if (params.get('registration') === 'success') {
                intro.textContent =
                    `Registration successful. Welcome, ${activity.user.name}. Your account details below are saved in the database.`;
            } else if (params.get('login') === 'success') {
                intro.textContent =
                    `Login successful. Welcome, ${activity.user.name}. Your account details below are loaded from the database.`;
            }
        } catch {
            intro.textContent = 'We could not load your account. Please try again.';
        }
    }

    if (document.getElementById('account-intro')) {
        loadAccount();
    }

    function requestTransportLink(order) {
        const link = document.createElement('a');
        link.href = `transport.html?order=${encodeURIComponent(order.id)}#request-transport`;
        link.textContent = 'Arrange delivery';
        return link;
    }

    const transportOrderId = document.getElementById('transport-order-id');
    if (transportOrderId) {
        const orderId = new URLSearchParams(window.location.search).get('order');
        if (orderId) {
            fetch('/api/my-activity')
                .then(async (response) => {
                    const result = await response.json();
                    if (!response.ok) throw new Error(result.message || 'Log in to arrange delivery for an order.');
                    const eligible = [...result.orders, ...result.ordersReceived]
                        .find((order) => order.id === orderId
                            && order.status === 'accepted'
                            && !order.deliveryRequestId);
                    if (!eligible) throw new Error('This order is not available for a new delivery request.');

                    const byBuyer = result.orders.some((order) => order.id === orderId);
                    const pickup = document.getElementById('pickup');
                    const destination = document.getElementById('destination');
                    const produce = document.getElementById('produce');
                    const weight = document.getElementById('weight');
                    transportOrderId.value = eligible.id;
                    pickup.value = byBuyer ? eligible.sellerLocation || '' : eligible.sellerLocation || eligible.location || '';
                    destination.value = eligible.address || '';
                    produce.value = eligible.product;
                    weight.value = eligible.quantityKg;
                    const summary = document.getElementById('transport-order-summary');
                    summary.textContent = `Delivery request for your accepted order: ${eligible.product}, ${formatKg(eligible.quantityKg)}. Check the pickup and destination details before submitting.`;
                    summary.hidden = false;
                })
                .catch((error) => {
                    const summary = document.getElementById('transport-order-summary');
                    summary.textContent = error instanceof Error ? error.message : 'Order details could not be loaded.';
                    summary.hidden = false;
                    summary.dataset.state = 'error';
                });
        }
    }

    /* ---------- Buyers page: order from one farmer's listing ---------- */
    const paymentMethod = document.getElementById('payment-method');
    const mobileMoneyOptions = document.getElementById('mobile-money-options');
    const mobileMoneyProvider = document.getElementById('mobile-money-provider');

    if (paymentMethod && mobileMoneyOptions && mobileMoneyProvider) {
        const updatePaymentOptions = () => {
            const usingMobileMoney = paymentMethod.value === 'mobile_money';
            mobileMoneyOptions.hidden = !usingMobileMoney;
            mobileMoneyProvider.disabled = !usingMobileMoney;
            mobileMoneyProvider.required = usingMobileMoney;
            if (!usingMobileMoney) mobileMoneyProvider.value = '';
        };
        paymentMethod.addEventListener('change', updatePaymentOptions);
        updatePaymentOptions();
    }

})();
