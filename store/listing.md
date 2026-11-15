# Social Backup

## Short description

Save your posts from X, Facebook, Instagram and Nostr. Download a copy with photos and videos, or share public posts on Nostr.

## Store description

Keep a copy of your social posts that you can take with you. Choose your accounts, visit your profiles and scroll to save the posts you want to keep. Connect your Nostr public key to import signed events from the relays you choose. Download your archive and saved media as a ZIP.

When you turn on backup for a social profile, Social Backup can automatically sign and publish confirmed public posts to your Nostr relays and upload public media to your chosen servers. Private or unverified captures stay in your browser and can be exported. Creating a new Nostr profile publishes your chosen name and public key. A public key alone gives you read-only access.

You can use the same Nostr profile to approve sign-ins and signatures on websites, open supported archive images, link your X account, or find people you follow on X. Optional Bitcoin tips on X use Lightning. Turn them on in Sources to see tip buttons. Scrolling matches accounts on your device. Opening a tip checks the X proof and looks up the current Lightning address. Your wallet approves the payment. All backup features are free.

## Listing fields

- Product name: Social Backup
- Language: English
- Chrome category: Tools (Productivity)
- Firefox category: Other
- Platforms: Desktop Firefox 140+, desktop Chrome. Select desktop only for this submission.
- Homepage: https://socialbackup.org/
- Support: https://github.com/mmalmi/social-backup/issues
- Privacy policy: https://socialbackup.org/privacy.html (deploy the prepared policy and verify this exact URL before submission)
- Terms of use: https://socialbackup.org/terms.html (optional; Firefox can attach it as the license agreement)
- Requires payment for functionality: No
- Screenshot caption: A local backup with saved posts, sync status and a ZIP download.
- Icon: icon-128.png. Screenshot: archive.png. Chrome small promotional tile: promo.png.

## Chrome privacy fields

Single purpose: Let people preserve and use their own social archive with a Nostr identity. The archive, media reader and signer let them save, share and use that content. Optional linking, follows and Lightning tips use the same identity. Describe these features openly if the reviewer asks how they fit the archive purpose.

- Personally identifiable information: profile names, public keys and linked usernames.
- Authentication information: the local Nostr secret key and website signing decisions. Only authorized public keys and signed results go to sites.
- Personal communications and website content: social posts, associated URLs and media, imported signed events and encrypted messages.
- Web history: limited to supported profile/post URLs used for capture, proof URLs and requested media. The extension has no browser history permission.
- Financial and payment information: optional Lightning addresses, tip amounts, invoices and signed zap requests.
- User activity: page changes and scrolling trigger local capture and directory matching. No interaction telemetry.
- Remote code: No. Executable code ships in the package. Network responses provide events, media, prices and invoices.
- Data use: feature delivery only. No sale of data, advertising, credit scoring or analytics. Review the dashboard certifications against the attached policy before signing.

Permission justifications:

- storage: account state notifications, pending website signing approvals and tab sessions.
- unlimitedStorage: the user's archive contains photos, videos and indexed event blocks that can exceed browser quotas.
- alarms: resume queued deliveries, sync the archive and refresh the optional identity directory when due.
- scripting: attach the packaged capture script to already-open supported profile tabs on installation.
- HTTPS site access: users choose Nostr clients, servers and media origins. Supported profiles supply archive content. The packaged signing provider serves approved site requests, and the media helper resolves archive images on pages. HTTP loopback access supports local media servers.

## Firefox fields

Distribution: listed on addons.mozilla.org. Upload the Firefox binary ZIP and the separate matching source ZIP. The manifest declares website content, personally identifying information, personal communications, authentication information and browsing activity for the core flows. Financial/payment data is optional and requested when enabling tips. Attach the privacy policy text from the supplied HTML page. Select the MIT License.
