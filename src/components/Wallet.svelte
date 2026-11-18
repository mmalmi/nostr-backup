<script lang="ts">
  import { onMount } from 'svelte';
  import qrcode from 'qrcode-generator';
  import { npubEncode } from 'nostr-tools/nip19';
  import type { Result } from '../types.ts';
  import { api, downloadBlob, send } from '../ui.ts';
  import { paymentConsent } from '../tip-consent.ts';
  import { quickTipFeeLimit } from '../quick-tip.ts';

  const [tipId, ...quickParts] = location.hash.slice(1).split('?');
  let quickToken = quickParts.length === 1 && /^[0-9a-f-]{36}$/.test(tipId)
    ? /^quick=([0-9a-f]{32})$/.exec(quickParts[0])?.[1] : undefined;
  const quickPopup = !!quickToken;
  let saveTipDefault = $state(quickParts.length === 1 && quickParts[0] === 'setDefault');
  // The grant belongs to this opening only. Reloads and history entries get ordinary review.
  if (quickToken) {
    try { history.replaceState(history.state, '', '#' + tipId); }
    catch { quickToken = undefined; }
  }
  const initialHash = location.hash;
  const amount = (sats: number) => sats.toLocaleString() + (sats === 1 ? ' sat' : ' sats');
  let account = '';
  let identity = $state<Result<'walletIdentity'>>();
  let wallet = $state<Result<'walletStatus'>>();
  let tip = $state<Result<'walletReview'>>();
  let incoming = $state<Result<'walletIncoming'>>();
  let section = $state<'fund' | 'withdraw' | 'backup' | 'settings'>();
  let manage = $state(false);
  let paymentId = $state(tipId), fundingId = $state('');
  let busy = $state(false), loading = $state(true), switched = $state(false), consent = $state(true);
  let message = $state(''), failure = $state('');
  let mintUrl = $state(''), fundingAmount = $state<number | undefined>();
  let withdrawal = $state(''), backupPass = $state(''), confirmPass = $state('');
  let restorePass = $state(''), restoreFile = $state<File>();
  let generation = 0, quotedOnOpen = false;
  let quickAmount = $state<number | undefined>(), secondsLeft = $state(0);
  let quickTimer: number | undefined, quickPending = false;
  let feeNotice = $state('');
  const validQuickAmount = $derived(quickAmount !== undefined && Number.isSafeInteger(quickAmount) &&
    quickAmount >= 1 && quickAmount <= 1_000_000);

  const payment = $derived(wallet?.payments.find(item => item.id === paymentId));
  const funding = $derived(wallet?.funding.find(item => item.id === fundingId));
  const npub = $derived(identity?.pubkey ? npubEncode(identity.pubkey) : '');
  const canOpen = $derived(identity?.unlocked && identity.enabled && !switched);
  const activityPayments = $derived(wallet?.payments.filter(item => item.id !== tipId) ?? []);
  const hasActivity = $derived(!!(wallet?.funding.length || activityPayments.length));
  const manageVisible = $derived(!tip || manage || !wallet?.mint || (!payment && wallet.balance < tip.sats));
  const qrImage = $derived.by(() => {
    if (funding?.state !== 'pending') return;
    try {
      const image = qrcode(0, 'M');
      image.addData('lightning:' + funding.invoice);
      image.make();
      return image.createDataURL(5, 20);
    } catch { return; }
  });

  function forget() {
    stopQuick();
    wallet = undefined;
    tip = undefined;
    incoming = undefined;
    section = undefined;
    manage = false;
    fundingId = '';
    paymentId = tipId;
    withdrawal = '';
    backupPass = confirmPass = restorePass = '';
    restoreFile = undefined;
    message = '';
  }

  async function load() {
    const version = ++generation;
    const current = await send('walletIdentity');
    if (version !== generation) return;
    if (identity && (current.pubkey !== identity.pubkey || current.quickTipSats !== identity.quickTipSats ||
        current.enabled !== identity.enabled || current.unlocked !== identity.unlocked)) stopQuick();
    identity = current;
    if (account && current.pubkey !== account) switched = true;
    if (!current.pubkey || !current.unlocked || !current.enabled || switched) {
      forget();
      if (current.pubkey && !account) account = current.pubkey;
      return;
    }
    account = current.pubkey;
    const allowed = await paymentConsent();
    if (version !== generation) return;
    consent = allowed;
    if (!allowed) { forget(); return; }
    if (current.lastIncoming && (!incoming || current.lastIncoming.checkedAt >= incoming.checkedAt)) incoming = current.lastIncoming;
    const status = await send('walletStatus', { account });
    if (version !== generation) return;
    wallet = status;
    if (tipId && !tip) {
      const review = await send('walletReview', { id: tipId, account });
      if (version === generation && review.account === account) tip = review;
    }
    if (quickPending && status.payments.some(item => item.id === tipId && item.state === 'paid')) {
      quickPending = false;
      window.close();
    }
    // Preparing a quote never pays it.
    if (version === generation && tip && !quotedOnOpen && !busy && status.mint &&
        status.balance >= tip.sats && !status.payments.some(item => item.id === tipId)) {
      quotedOnOpen = true;
      prepareTip();
    }
  }

  async function refresh() {
    try { await load(); }
    catch (error) { forget(); failure = (error as Error).message; }
    finally { loading = false; }
  }

  async function act(action: () => Promise<void>) {
    if (busy) return;
    busy = true;
    failure = message = '';
    try { await action(); }
    catch (error) { stopQuick(); failure = (error as Error).message; }
    finally { await refresh(); busy = false; }
  }

  onMount(() => {
    void refresh();
    // An approval from a previous profile must disappear when the active account changes.
    api.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.settingsChanged) {
        stopQuick();
        void refresh();
      }
    });
    const onFocus = () => { if (!busy) void refresh(); };
    // Status reads stay on device. A visible, explicitly opened invoice can check its own mint quote.
    let watching = '', checks = 0, checking = false;
    const timer = window.setInterval(async () => {
      if (document.visibilityState !== 'visible' || busy || checking || !canOpen) return;
      const deposit = section === 'fund' && funding?.state === 'pending' ? funding.id : '';
      const spend = payment?.state === 'pending' ? payment.id : '';
      const current = deposit || spend;
      if (current !== watching) { watching = current; checks = 0; }
      checking = true;
      try {
        if (current && checks < 12) {
          checks++;
          if (deposit) await send('walletRefreshFunding', { account, id: deposit });
          else await send('walletRefresh', { account, id: spend });
        }
        await refresh();
      } catch { /* Manual checks remain available if the mint is offline. */ }
      finally { checking = false; }
    }, 15000);
    const onHash = () => {
      if (location.hash !== initialHash) { stopQuick(); location.reload(); }
    };
    const onVisibility = () => { if (document.visibilityState !== 'visible') stopQuick(); };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && secondsLeft && !busy) cancel();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', stopQuick);
    window.addEventListener('pagehide', stopQuick);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onFocus);
    window.addEventListener('hashchange', onHash);
    return () => {
      stopQuick();
      window.clearInterval(timer);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', stopQuick);
      window.removeEventListener('pagehide', stopQuick);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('hashchange', onHash);
    };
  });

  function stopQuick() {
    quickToken = undefined;
    if (quickTimer !== undefined) window.clearInterval(quickTimer);
    quickTimer = undefined;
    secondsLeft = 0;
  }

  function inForeground() {
    return document.visibilityState === 'visible' && document.hasFocus();
  }

  // Wait for the complete recipient and quote to be rendered before starting the cancel window.
  $effect(() => {
    if (!quickToken || busy || loading) return;
    if (tip && identity?.quickTipSats === tip.sats && payment?.state === 'ready' &&
        payment.fee > quickTipFeeLimit(tip.sats)) {
      feeNotice = 'The fee exceeds your one-click limit of ' + amount(quickTipFeeLimit(tip.sats)) + '.';
    }
    if (!inForeground() || !canOpen || !tip?.post || tip.id !== tipId || tip.account !== account ||
        tip.sats !== identity?.quickTipSats || !wallet?.mint || !payment ||
        payment.id !== tipId || payment.state !== 'ready' || payment.invoice !== tip.invoice ||
        payment.sats !== tip.sats || !Number.isSafeInteger(payment.fee) || payment.fee < 0 ||
        payment.fee > quickTipFeeLimit(tip.sats)) {
      stopQuick();
      return;
    }
    if (quickTimer !== undefined) return;
    const fee = payment.fee, sats = tip.sats, invoice = payment.invoice, owner = account;
    let elapsed = 0, previous = Date.now();
    secondsLeft = 3;
    quickTimer = window.setInterval(() => {
      const now = Date.now(), step = now - previous;
      // A suspended tab, sleeping computer, or stalled event loop must not finish the countdown.
      if (!inForeground() || step < 0 || step > 750 || busy || !quickToken || !canOpen ||
          identity?.pubkey !== owner || identity.quickTipSats !== sats || payment?.id !== tipId ||
          payment.state !== 'ready' || payment.fee !== fee || payment.invoice !== invoice) {
        stopQuick();
        return;
      }
      previous = now;
      elapsed += step;
      if (elapsed < 2500) {
        secondsLeft = Math.ceil((2500 - elapsed) / 1000);
        return;
      }
      const token = quickToken;
      stopQuick();
      void act(async () => {
        const result = await send('walletQuickConfirm', { account: owner, id: tipId, token, maxFee: fee });
        if (result.state === 'paid') window.close();
        else quickPending = result.state === 'pending';
      });
    }, 100);
  });

  function setQuickAmount(sats: number) {
    void act(async () => {
      if (!Number.isSafeInteger(sats) || sats < 0 || sats > 1_000_000) throw Error('Choose 1 to 1,000,000 sats.');
      await send('walletSetQuickTip', { account, sats });
      quickAmount = sats || undefined;
      message = sats ? 'One-click tips saved.' : 'One-click tips turned off.';
    });
  }

  function preferences(enabled: boolean, autoReceive: boolean) {
    void act(async () => {
      if (enabled && !await paymentConsent(true)) throw Error('Allow payment data in the extension to use the wallet.');
      await send('walletPreferences', { account, enabled, autoReceive });
    });
  }

  function discoverMint() {
    void act(async () => {
      mintUrl = await send('walletDiscoverMint', { account });
      message = 'Review the mint address before using it.';
    });
  }

  function selectMint() {
    void act(async () => {
      await send('walletSelectMint', { account, url: mintUrl.trim() });
      mintUrl = '';
      message = 'Mint selected.';
    });
  }

  function showSection(next: typeof section) {
    if (section !== next) {
      backupPass = confirmPass = restorePass = '';
      restoreFile = undefined;
      withdrawal = '';
    }
    section = section === next ? undefined : next;
    if (section === 'settings') quickAmount = identity?.quickTipSats || undefined;
    failure = message = '';
    if (next === 'fund') fundingId = '';
    if (!tipId && next === 'withdraw') paymentId = '';
  }

  function addFunds() {
    void act(async () => {
      if (!Number.isSafeInteger(fundingAmount) || !fundingAmount || fundingAmount < 1)
        throw Error('Enter a whole number of sats.');
      const quote = await send('walletFund', { account, sats: fundingAmount });
      fundingId = quote.id;
    });
  }

  function prepareTip() {
    quotedOnOpen = true;
    void act(async () => {
      const result = await send('walletPrepare', { account, id: tipId });
      paymentId = result.id;
    });
  }

  function prepareWithdrawal() {
    void act(async () => {
      const result = await send('walletPrepareWithdrawal', { account, invoice: withdrawal.trim().replace(/^lightning:/i, '') });
      paymentId = result.id;
      withdrawal = '';
    });
  }

  function confirm() {
    stopQuick();
    if (!payment || payment.state !== 'ready') return;
    const { id, fee } = payment;
    const defaultSats = saveTipDefault && tip?.id === id && tip.sats !== identity?.quickTipSats ? tip.sats : undefined;
    void act(async () => {
      if (defaultSats) await send('walletSetQuickTip', { account, sats: defaultSats });
      await send('walletConfirm', { account, id, maxFee: fee });
    });
  }

  function recoverPayment() {
    if (!payment) return;
    const { id } = payment;
    void act(async () => { await send('walletRefresh', { account, id }); });
  }

  function cancel() {
    stopQuick();
    if (!payment) return;
    const { id } = payment;
    void act(async () => {
      await send('walletCancel', { account, id });
      message = 'Payment canceled.';
      if (quickPopup && id === tipId) window.close();
    });
  }

  function checkIncoming() {
    void act(async () => { incoming = await send('walletIncoming', { account }); });
  }

  function saveBackup() {
    void act(async () => {
      if (backupPass !== confirmPass) throw Error('The passphrases differ. Enter them again.');
      const json = await send('walletExport', { account, passphrase: backupPass });
      const file = new Blob([json], { type: 'application/json' });
      backupPass = confirmPass = '';
      downloadBlob(file, 'social-backup-wallet-' + new Date().toISOString().slice(0, 10) + '.wallet.json');
      message = 'Encrypted wallet backup downloaded.';
    });
  }

  function restoreBackup() {
    void act(async () => {
      if (!restoreFile) throw Error('Choose an encrypted wallet backup.');
      if (restoreFile.size > 32 * 1024 * 1024) throw Error('This file is too large to be a wallet backup.');
      const json = await restoreFile.text();
      await send('walletRestore', { account, json, passphrase: restorePass });
      restorePass = '';
      restoreFile = undefined;
      section = undefined;
      message = 'Wallet restored.';
    });
  }

  function openPayment(id: string) {
    if (!id.startsWith('withdraw-')) {
      location.assign(api.runtime.getURL('wallet.html') + '#' + encodeURIComponent(id));
      return;
    }
    paymentId = id;
    section = 'withdraw';
    document.querySelector('main')?.scrollIntoView({ block: 'start' });
  }
</script>

<header class="walletHeader">
  <h1 class="brand"><img src="icon.svg" alt="" />Cashu wallet</h1>
  {#if npub && !switched}
    <span class="identity" title={npub}>{npub.slice(0, 10)}…{npub.slice(-5)}</span>
  {/if}
</header>

{#if loading}
  <p role="status">Opening wallet…</p>
{:else if switched}
  <section><p>The active profile changed.</p><button onclick={() => location.reload()}>Reload wallet</button></section>
{:else if !identity?.pubkey || !identity.unlocked}
  <section><h2>{identity?.pubkey ? 'Unlock your profile' : 'Sign in to Social Backup'}</h2>
    <a class="button secondary" href="archive.html#account">Open Keys &amp; access</a>
  </section>
{:else if !identity.enabled}
  <section><h2>Pay tips with Cashu</h2>
    <p>Keep a balance in sats on this device and confirm each tip here. You choose the mint that holds your bitcoin.</p>
    <button disabled={busy} onclick={() => preferences(true, false)}>Enable wallet</button>
  </section>
{:else if !consent}
  <section><h2>Allow payment data</h2><p>Firefox requires this permission to use the wallet.</p>
    <button disabled={busy} onclick={() => preferences(true, identity!.autoReceive)}>Allow wallet access</button>
    <button class="secondary" disabled={busy} onclick={() => preferences(false, false)}>Turn off wallet</button>
  </section>
{:else if canOpen && wallet}
  {#if tipId && tip}
    <section class="tipReview" aria-labelledby="tipTitle">
      <h2 id="tipTitle">{payment?.state === 'paid' ? 'Tip paid' : 'Tip @' + tip.handle}</h2>
      <p class="largeAmount">{amount(tip.sats)}</p>
      <dl>
        <div><dt>Recipient</dt><dd>{tip.lightning}</dd></div>
        {#if tip.post}<div><dt>X post</dt><dd>{tip.post}</dd></div>{/if}
      </dl>
      {#if payment}
        {@render review()}
      {:else if wallet.mint && wallet.balance >= tip.sats}
        <button disabled={busy} onclick={prepareTip}>{busy ? 'Getting fee…' : 'Review fee'}</button>
      {:else}
        <p>{wallet.mint ? 'Add sats to cover this tip and its fee.' : 'Choose a mint and add sats to pay this tip.'}</p>
      {/if}
      {#if !secondsLeft && wallet.mint && (payment || wallet.balance >= tip.sats)}
        <div class="tipFooter"><small>Available balance · {amount(wallet.balance)}</small>
          <button class="quiet" aria-expanded={manageVisible} disabled={busy} onclick={() => { stopQuick(); manage = !manage; }}>Manage wallet</button>
        </div>
      {/if}
    </section>
  {/if}

  {#if manageVisible}
  <section aria-labelledby="balanceTitle">
    <h2 id="balanceTitle" class="subhead">Available balance</h2>
    <p class="largeAmount">{amount(wallet.balance)}</p>
    {#if wallet.mint}<p class="mint">{wallet.mint}</p>{/if}
    <div class="actions">
      {#if wallet.mint}
        <button aria-expanded={section === 'fund'} disabled={busy} onclick={() => showSection('fund')}>Add sats</button>
        {#if !tipId}<button class="secondary" aria-expanded={section === 'withdraw'} disabled={busy} onclick={() => showSection('withdraw')}>Pay invoice</button>{/if}
      {/if}
      <button class="secondary" aria-expanded={section === 'settings'} disabled={busy} onclick={() => showSection('settings')}>Wallet settings</button>
    </div>
  </section>

  {#if !wallet.mint}
    <section><h2>Choose your mint</h2>
      <p>The mint holds the bitcoin backing your Cashu balance. Enter the address of a mint you trust.</p>
      {@render mintForm()}
    </section>
  {/if}

  {#if section === 'fund' && wallet.mint}
    <section><h2>Add sats</h2>
      {#if funding}
        <p class="largeAmount">{amount(funding.sats)}</p>
        {#if funding.state === 'pending'}
          <p>Pay this Lightning invoice from another wallet. This page checks for payment while open.</p>
          {#if qrImage}<img class="fundingQr" src={qrImage} alt="Lightning invoice QR code" />{/if}
          <div class="actions"><a class="button secondary" href={'lightning:' + funding.invoice}>Open Lightning wallet</a>
            <button class="secondary" disabled={busy} onclick={() => void act(async () => { await navigator.clipboard.writeText(funding!.invoice); message = 'Invoice copied.'; })}>Copy invoice</button>
            <button disabled={busy} onclick={() => void act(async () => { await send('walletRefreshFunding', { account, id: funding!.id }); })}>Check payment</button>
          </div>
        {:else}
          <p>{funding.state === 'paid' ? 'Added to your balance.' : funding.state === 'failed' ? 'The mint reported that this deposit failed.' : 'This invoice expired.'}</p>
          <button class="secondary" onclick={() => fundingId = ''}>New invoice</button>
        {/if}
      {:else}
        <form onsubmit={(e) => { e.preventDefault(); addFunds(); }}>
          <label>Amount in sats <input type="number" min="1" step="1" inputmode="numeric" required bind:value={fundingAmount} /></label>
          <button disabled={busy || !fundingAmount}>Create Lightning invoice</button>
        </form>
      {/if}
    </section>
  {/if}

  {#if section === 'withdraw' && !tipId}
    <section><h2>Pay a Lightning invoice</h2>
      {#if payment}
        <p class="largeAmount">{amount(payment.sats)}</p>
        <details><summary>Invoice · {payment.invoice.slice(0, 12)}…{payment.invoice.slice(-8)}</summary><p class="invoice">{payment.invoice}</p></details>
        {@render review()}
        {#if payment.state === 'paid' || payment.state === 'failed'}<button class="secondary" onclick={() => paymentId = ''}>New payment</button>{/if}
      {:else}
        <form onsubmit={(e) => { e.preventDefault(); prepareWithdrawal(); }}>
          <label>Lightning invoice <textarea bind:value={withdrawal} rows="3" required spellcheck="false" placeholder="lnbc…" autocomplete="off"></textarea></label>
          <button disabled={busy || !withdrawal.trim()}>Review payment</button>
        </form>
      {/if}
    </section>
  {/if}

  {#if section === 'settings'}
    <section><h2>Wallet settings</h2>
      <h3>One-click post tips</h3>
      <p>Click a post’s flower to send your saved amount after a short countdown. Hold the flower to choose an amount. Profiles always open the tip menu.</p>
      {#if identity.quickTipSats}<p>One-click tips are on at <strong>{amount(identity.quickTipSats)}</strong> per post.</p>{/if}
      <form onsubmit={(e) => { e.preventDefault(); if (validQuickAmount && quickAmount) setQuickAmount(quickAmount); }}>
        <label>Sats per tip <input type="number" min="1" max="1000000" step="1" inputmode="numeric" placeholder="21" required bind:value={quickAmount} /></label>
        {#if validQuickAmount && quickAmount}<p>Maximum fee per tip is {amount(quickTipFeeLimit(quickAmount))}.</p>{/if}
        <div class="actions">
          <button disabled={busy || !validQuickAmount || quickAmount === identity.quickTipSats}>
            {identity.quickTipSats ? 'Save tip amount' : 'Enable one-click tips'}
          </button>
          {#if identity.quickTipSats}<button type="button" class="secondary" disabled={busy} onclick={() => setQuickAmount(0)}>Turn off one-click tips</button>{/if}
        </div>
      </form>
      <h3>Incoming tips</h3>
      <p>Your npub.cash inbox can receive Lightning payments for this Nostr profile. Checking it signs a request to npub.cash.</p>
      <label class="check"><input type="checkbox" checked={identity.autoReceive} disabled={busy}
        onchange={(e) => preferences(true, e.currentTarget.checked)} />Check every 15 minutes while unlocked</label>
      <button class="secondary" disabled={busy} onclick={checkIncoming}>Check inbox now</button>
      {#if incoming}
        <p role="status">Last checked {new Date(incoming.checkedAt).toLocaleString()}.
          {incoming.claimed ? 'Claimed ' + amount(incoming.claimed) + '.' : 'No sats claimed.'}
          {#if incoming.available} {amount(incoming.available)} available.
            {#if incoming.mints.length} Mint: {incoming.mints.join(', ')}.{/if}
          {/if}
        </p>
      {/if}
      {#if wallet.mint}
        <details><summary>Change mint</summary><p>Withdraw your balance and finish pending payments before changing mints.</p>{@render mintForm()}</details>
      {/if}
      <details><summary>Turn off wallet</summary><p>Your balance stays on this device.</p>
        <button class="secondary" disabled={busy} onclick={() => preferences(false, false)}>Turn off wallet</button></details>
    </section>
  {/if}

  {#if hasActivity}
    <section><h2>Wallet activity</h2>
      <ul class="activity">
        {#each wallet.funding.slice().reverse() as item (item.id)}
          <li><span>Add {amount(item.sats)}<small>{item.state === 'pending' ? 'Awaiting payment' : item.state === 'paid' ? 'Received' : item.state === 'failed' ? 'Failed' : 'Expired'}</small></span>
            {#if item.state === 'pending'}<button class="secondary" disabled={busy} onclick={() => { fundingId = item.id; section = 'fund'; }}>Open invoice</button>{/if}
          </li>
        {/each}
        {#each activityPayments.slice().reverse() as item (item.id)}
          <li><span>{item.id.startsWith('withdraw-') ? 'Payment' : 'Tip'} · {amount(item.sats)}
            <small>{item.state === 'ready' ? 'Awaiting confirmation' : item.state === 'pending' ? 'Checking settlement' : item.state === 'paid' ? 'Paid' : 'Unpaid'}</small></span>
            {#if (item.state === 'ready' || item.state === 'pending') && item.id !== payment?.id}
              {#if tipId && item.id.startsWith('withdraw-')}
                <a class="button secondary" href="wallet.html">Open wallet</a>
              {:else}
                <button class="secondary" disabled={busy} onclick={() => openPayment(item.id)}>Review</button>
              {/if}
            {/if}
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  <section class="backup">
    <h2>Wallet backup</h2>
    {#if wallet.mint}<p>A wallet file contains spendable funds. Save a fresh encrypted copy after payments and keep your passphrase safe.</p>
    {:else}<p>If you already have a backup from this profile, restore it before choosing a mint.</p>{/if}
    <button class="secondary" aria-expanded={section === 'backup'} disabled={busy} onclick={() => showSection('backup')}>{wallet.mint ? 'Back up wallet' : 'Restore from file'}</button>
    {#if section === 'backup'}
      {#if wallet.mint}<form onsubmit={(e) => { e.preventDefault(); saveBackup(); }}>
        <label>New backup passphrase <input type="password" autocomplete="new-password" minlength="12" required bind:value={backupPass} /></label>
        <label>Confirm passphrase <input type="password" autocomplete="new-password" required bind:value={confirmPass} /></label>
        <button disabled={busy || backupPass.length < 12 || !confirmPass}>Download encrypted backup</button>
      </form>{/if}
      {#if !wallet.mint}<details open><summary>Restore a wallet file</summary>
        <p>Use your most recent backup on a single device. Open the same Nostr profile on the new device and restore before choosing a mint.</p>
        <form onsubmit={(e) => { e.preventDefault(); restoreBackup(); }}>
          <label>Backup file <input type="file" accept=".json,application/json" required onchange={(e) => restoreFile = e.currentTarget.files?.[0]} /></label>
          <label>Backup passphrase <input type="password" autocomplete="off" required bind:value={restorePass} /></label>
          <button disabled={busy || !restoreFile || restorePass.length < 12}>Restore wallet</button>
        </form>
      </details>{/if}
    {/if}
  </section>
  {/if}
{:else}
  <section><h2>Wallet unavailable</h2>
    <button disabled={busy} onclick={() => { failure = ''; void refresh(); }}>Try again</button>
    {#if tipId}<a class="button secondary" href="wallet.html">Open wallet</a>{/if}
  </section>
{/if}

{#if failure}<p class="feedback error" role="alert">{failure}</p>{:else if message || busy}<p class="feedback" role="status">{busy ? 'Working…' : message}</p>{/if}

{#snippet mintForm()}
  <form onsubmit={(e) => { e.preventDefault(); selectMint(); }}>
    <label>Mint URL <input type="url" bind:value={mintUrl} placeholder="https://mint.example" required autocomplete="off" /></label>
    <div class="actions"><button disabled={busy || !mintUrl.trim()}>Use this mint</button>
      <button type="button" class="secondary" disabled={busy} onclick={discoverMint}>Find my npub.cash mint</button>
    </div>
  </form>
{/snippet}

{#snippet review()}
  {#if payment?.state === 'ready'}
    <dl>
      <div><dt>Maximum fee</dt><dd>{amount(payment.fee)}</dd></div>
      <div><dt>Maximum total</dt><dd><strong>{amount(payment.sats + payment.fee)}</strong></dd></div>
    </dl>
    {#if tip?.id === payment.id && !quickPopup && identity?.quickTipSats !== payment.sats}
      <label class="check"><input type="checkbox" bind:checked={saveTipDefault} disabled={busy} />
        Use {amount(payment.sats)} for one-click post tips</label>
      {#if saveTipDefault}<p>Maximum fee on future one-click tips: {amount(quickTipFeeLimit(payment.sats))}.</p>{/if}
    {/if}
    {#if feeNotice}<p>{feeNotice}</p>{/if}
    {#if secondsLeft}<p class="quickCountdown" role="status">Sending in {secondsLeft} {secondsLeft === 1 ? 'second' : 'seconds'}…</p>{/if}
    <div class="actions">
      {#if !secondsLeft}<button disabled={busy} onclick={confirm}>{tip ? saveTipDefault && identity?.quickTipSats !== payment.sats ? 'Confirm tip and save default' : 'Confirm tip' : 'Confirm payment'}</button>{/if}
      <button class:secondary={!secondsLeft} disabled={busy} onclick={cancel}>Cancel</button>
    </div>
  {:else if payment?.state === 'pending'}
    <p role="status">Payment in progress. You can close this tab and check it again in wallet activity.</p>
    <button class="secondary" disabled={busy} onclick={recoverPayment}>Check payment</button>
  {:else if payment?.state === 'paid'}
    <p class="paid" role="status">✓ Payment complete</p>
  {:else if payment?.state === 'failed'}
    <p role="status">Payment did not complete. {tip ? 'Open the tip again for a new invoice.' : 'You can start a new payment.'}</p>
  {/if}
{/snippet}

<style>
  :global(.wallet main) { max-width: 600px; }
  .walletHeader, .activity li, dl > div { display: flex; justify-content: space-between; align-items: baseline; gap: .8rem; }
  .walletHeader { align-items: center; flex-wrap: wrap; margin-bottom: 20px; }
  .identity, .mint, .subhead, dt, small { color: var(--muted); }
  .identity, .invoice { font: .83rem/1.5 ui-monospace, monospace; }
  .subhead { font-size: 1rem; margin-bottom: 0; }
  .largeAmount { color: var(--ink); font-size: clamp(1.6rem, 6vw, 2.3rem); line-height: 1.2; font-weight: 650; letter-spacing: -.035em; margin: 6px 0 10px; }
  dl { margin: 12px 0 16px; }
  dl > div { padding: 3px 0; }
  dd { margin: 0; text-align: right; overflow-wrap: anywhere; }
  .tipReview { border-top: 3px solid var(--brand); }
  .tipFooter { display: flex; align-items: center; justify-content: space-between; gap: .4rem; flex-wrap: wrap; border-top: 1px solid var(--line); margin-top: 1rem; padding-top: .5rem; }
  .tipFooter .quiet { padding: 5px 0; }
  .actions { align-items: center; }
  .activity { padding: 0; margin: 0; list-style: none; }
  .activity li { padding: .7rem 0; align-items: center; border-top: 1px solid var(--line); }
  .activity small { display: block; }
  .activity li:first-child { border-top: none; }
  .fundingQr { display: block; width: min(100%, 250px); margin: 1rem auto; image-rendering: pixelated; }
  details { margin: .8rem 0; }
  summary { color: var(--brand); font-weight: 600; cursor: pointer; }
  h3 { font-size: 1rem; margin-bottom: .3rem; }
  .quickCountdown { color: var(--ink); font-weight: 600; }
  .paid { color: var(--ok); font-weight: 650; }
  .feedback { position: sticky; bottom: .6rem; margin: .5rem 0; padding: .7rem .9rem; border-radius: 8px; background: var(--ink); color: var(--card); }
  .feedback.error { border-inline-start: .35rem solid var(--danger); }
  .backup form { margin: .8rem 0; }
  @media (max-width: 440px) {
    :global(.wallet main) { padding: 22px 14px; }
    section { padding: 16px; }
  }
</style>
