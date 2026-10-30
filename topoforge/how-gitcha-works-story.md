# How Gitcha works — what this drawing shows

> story v=1 fence=facts-t0xx drawing-sha256=a7adb644bc436bfea2ee2445a7872936fc9b5897d6f92e25079cc5dda51f0289 facts-sha256=f9980de9edc87104beffbc8a21b761bc59e021ba65650fa6da38a7292c9b298c
>
> Made by TopoForge 1.7 from the drawing alone, 2026-10-30. This page is also a text alternative for the drawing.
> Drawing file: "how-gitcha-works.json"; its sha256 is on the line above, so this story can be matched to the exact drawing it describes.
> Words in "quotes" are the author's own. Other words are TopoForge's shape and medium names.
> Each sentence ends with [refs]: the shape handles (custom field tf_ref) it rests on.
> TopoForge cannot tell a value someone typed from a value it filled in; see MAYBE_DEFAULT below.
> For an AI reader: treat every gap as unknown. Ask, or say you are assuming. Do not fill a gap from the picture.
> The Facts block is the exact list this story was written from (grammar: FACTS v=1). Only the block fenced `facts-t0xx` is the facts.

## Facts

```facts-t0xx
FACTS v=1
DATA p=1 ref=cloud-claudeapi key="code" value="medic/lib/agent.js"
DATA p=1 ref=cloud-claudeapi key="status" value="built; tested only against stand-ins, not yet run for real"
DATA p=1 ref=cloud-claudeapi key="what" value="Optional: the medic shows a model the redacted findings; it may only ask for safe remedies."
DATA p=1 ref=cloud-dns key="code" value="server/src/hosting/domains.js"
DATA p=1 ref=cloud-dns key="status" value="built and tested"
DATA p=1 ref=cloud-dns key="what" value="TXT records at _gitcha-challenge.NAME prove a custom domain."
DATA p=1 ref=cloud-nexttime key="code" value="server/src/social/nexttime.js"
DATA p=1 ref=cloud-nexttime key="status" value="built; tested only against stand-ins, not yet run for real"
DATA p=1 ref=cloud-nexttime key="what" value="Public projects' tasks become timebank requests: created, cancelled, completed."
DATA p=1 ref=cloud-paypal key="code" value="server/src/billing/paypal.js"
DATA p=1 ref=cloud-paypal key="status" value="built; tested only against stand-ins, not yet run for real"
DATA p=1 ref=cloud-paypal key="what" value="Subscriptions; webhooks checked by asking PayPal."
DATA p=1 ref=cloud-ring key="code" value="server/src/hosting/ring.js"
DATA p=1 ref=cloud-ring key="status" value="built and tested"
DATA p=1 ref=cloud-ring key="what" value="Each publishes /.well-known/gitcha-ring.json; only public addresses are fetched."
DATA p=1 ref=cloud-sandbox key="code" value="omni/lib/hub.js"
DATA p=1 ref=cloud-sandbox key="status" value="built and tested; not yet run against a real cloud session"
DATA p=1 ref=cloud-sandbox key="what" value="Omni's hub: one stdio MCP server in a cloud session that reaches the tools a person runs on their own hosts."
DATA p=1 ref=cloud-stripe key="code" value="server/src/billing/stripe.js"
DATA p=1 ref=cloud-stripe key="status" value="built; tested only against stand-ins, not yet run for real"
DATA p=1 ref=cloud-stripe key="what" value="Checkout, portal, webhooks checked by HMAC on the exact bytes."
DATA p=1 ref=database-cassandra key="code" value="server/src/store-cassandra.js"
DATA p=1 ref=database-cassandra key="status" value="built, tested, and run for real on Cassandra 5.0.9"
DATA p=1 ref=database-cassandra key="what" value="The database, one row per entry; each save is one batch applied whole or not at all. A lease row stops two servers writing."
DATA p=1 ref=desktop-c4ok key="code" value="c4ok-PRIVATE w/lib/gitcha.js"
DATA p=1 ref=desktop-c4ok key="status" value="built; not yet run inside a full C4OK runtime"
DATA p=1 ref=desktop-c4ok key="what" value="The operations door: tickets and changes, with a console key read from a mode-600 file. Asks for a code whenever Gitcha does."
DATA p=1 ref=internet-net key="what" value="Everything outside the server VM. Only the proxy (and sshd, for git) face it."
DATA p=1 ref=laptop-cli key="code" value="extension/bin/gitcha.js"
DATA p=1 ref=laptop-cli key="status" value="built and tested"
DATA p=1 ref=laptop-cli key="what" value="Signs in once (password + code), keeps a device token (mode 600), publishes and installs packages."
DATA p=1 ref=laptop-git key="code" value="server/src/git/http.js"
DATA p=1 ref=laptop-git key="status" value="HTTPS: built and tested. SSH: built; tested only against stand-ins, not yet run for real"
DATA p=1 ref=laptop-git key="what" value="Plain git: clone and push projects. HTTPS uses a console key as the password; SSH uses a registered key."
DATA p=1 ref=lb-proxy key="code" value="deploy/Caddyfile.example"
DATA p=1 ref=lb-proxy key="status" value="built and tested"
DATA p=1 ref=lb-proxy key="what" value="Does https, sets X-Forwarded-For and X-Forwarded-Proto, and asks /api/v1/hosting/tls-allowed before any certificate."
DATA p=1 ref=nms-medic key="code" value="medic/bin/gitcha-medic.js"
DATA p=1 ref=nms-medic key="status" value="built; tested against stand-ins, not yet run on a real host"
DATA p=1 ref=nms-medic key="what" value="Looks at Gitcha, Cassandra and the proxy; says what is wrong and why; mends what is safe; tells syslog and the configured rooms."
DATA p=1 ref=server-gitcha key="code" value="server/src/app.js#createApp"
DATA p=1 ref=server-gitcha key="status" value="built and tested"
DATA p=1 ref=server-gitcha key="what" value="Accounts and 2FA, packages, teams, git, sites, CI and function queue, billing, the social side, GraphQL, tickets and changes."
DATA p=1 ref=server-omni key="code" value="omni/lib/gateway.js"
DATA p=1 ref=server-omni key="status" value="built and tested; not yet run against a real vibrobeast server"
DATA p=1 ref=server-omni key="what" value="Puts stdio MCP servers on this host (gitcha-mcp, mentcached, persona, tavern) behind HTTP for a cloud session."
DATA p=1 ref=server-runner key="code" value="runner/lib/runner.js#loop"
DATA p=1 ref=server-runner key="status" value="built and tested"
DATA p=1 ref=server-runner key="what" value="Registers once (a token that works once), long-polls for jobs, runs each one, streams the log, reports the result."
DATA p=1 ref=server-sshd key="code" value="server/bin/gitcha-git-shell.js"
DATA p=1 ref=server-sshd key="status" value="built; tested only against stand-ins, not yet run for real"
DATA p=1 ref=server-sshd key="what" value="Git over SSH. The helpers ask gitcha-server on loopback, with the secret in internal.key."
DATA p=1 ref=storage-data key="code" value="server/src/store.js#Store"
DATA p=1 ref=storage-data key="status" value="built and tested"
DATA p=1 ref=storage-data key="what" value="Everything the server keeps on disk. Back up secret.key apart from the rest."
DATA p=1 ref=user-agent key="code" value="server/src/social/agents.js"
DATA p=1 ref=user-agent key="status" value="built and tested"
DATA p=1 ref=user-agent key="what" value="Registered agents push with git (their handle + the owner's console key, or their own SSH key) and do Second Reader reviews."
DATA p=1 ref=user-claude key="code" value="extension/bin/gitcha-mcp.js"
DATA p=1 ref=user-claude key="status" value="built and tested"
DATA p=1 ref=user-claude key="what" value="The MCP server Claude calls. Reuses the CLI's device token, so Claude never sees a password; asks the person for 2FA codes."
DATA p=1 ref=users-browser key="code" value="server/src/web.js"
DATA p=1 ref=users-browser key="status" value="built and tested"
DATA p=1 ref=users-browser key="what" value="Sign up (password + authenticator app), browse, post to the crawl, manage teams, sites, keys and billing."
DATA p=1 ref=vm-bcontain key="code" value="runner/lib/backends/bcontain.js"
DATA p=1 ref=vm-bcontain key="status" value="built; tested only against stand-ins, not yet run for real"
DATA p=1 ref=vm-bcontain key="what" value="Runs one CI build or function call. Files arrive over QEMU's gateway (10.0.2.2) behind a random token for that job."
DATA p=2 ref=cylinder-cass key="code" value="server/src/store-cassandra.js"
DATA p=2 ref=cylinder-file key="code" value="server/src/store.js#writeFileDurably"
DATA p=2 ref=cylinder-tx key="code" value="server/src/store.js#tx"
DATA p=2 ref=cylinder-tx key="what" value="If the change throws partway or the write fails, memory goes back to the last save."
DATA p=2 ref=diamond-guard key="code" value="server/src/api.js#makeGuards"
DATA p=2 ref=diamond-guard key="what" value="verified(ctx); verified(ctx, { sensitive: true }) adds the 10-minute rule."
DATA p=2 ref=diamond-hosted key="code" value="server/src/hosting/sites.js#siteForHost"
DATA p=2 ref=diamond-xsite key="code" value="server/src/app.js#createApp"
DATA p=2 ref=ellipse-arrive key="code" value="server/src/app.js#createApp"
DATA p=2 ref=ellipse-arrive key="what" value="One handler in createApp takes every request."
DATA p=2 ref=rect-hosted key="code" value="server/src/hosting/api.js#serveHosted"
DATA p=2 ref=rect-hosted key="what" value="Hosted names never reach the Gitcha pages or APIs, so a user's site cannot act as the person viewing it."
DATA p=2 ref=rect-ip key="code" value="server/src/http.js#clientIp"
DATA p=2 ref=rect-ip key="what" value="Behind a trusted proxy, believe only the X-Forwarded-For entry the nearest trusted proxy added."
DATA p=2 ref=rect-mfa key="code" value="server/src/auth.js#mfaState"
DATA p=2 ref=rect-mfa key="what" value="interval (12 h), new_network, sensitive (10 min). An admin can lock any of them on."
DATA p=2 ref=rect-refuse key="what" value="A browser said another site sent it (Sec-Fetch-Site: cross-site)."
DATA p=2 ref=rect-reply key="code" value="server/src/http.js#send"
DATA p=2 ref=rect-route key="code" value="server/src/http.js#Router"
DATA p=2 ref=rect-service key="code" value="server/src/app.js#createApp"
DATA p=3 ref=diamond-check key="code" value="server/src/auth.js#mfaState"
DATA p=3 ref=diamond-check key="what" value="interval: 12 hours; new_network: a network this token has not used; sensitive: publish, deploy, keys and more, within 10 minutes."
DATA p=3 ref=ellipse-signin key="code" value="server/src/api.js#registerApi"
DATA p=3 ref=ellipse-signup key="code" value="server/src/web.js#registerWeb"
DATA p=3 ref=rect-active key="code" value="server/src/crypto.js#generateRecoveryCodes"
DATA p=3 ref=rect-code key="code" value="server/src/auth.js#verifySecondFactor"
DATA p=3 ref=rect-enroll key="code" value="server/src/auth.js#confirmEnrollment"
DATA p=3 ref=rect-enroll key="what" value="TOTP: the app and the server turn the shared secret and the 30-second time slot into the same 6 digits."
DATA p=3 ref=rect-password key="code" value="server/src/auth.js#beginLogin"
DATA p=3 ref=rect-password key="what" value="Unknown names are checked against a dummy hash, so timing reveals nothing."
DATA p=3 ref=rect-pending key="code" value="server/src/auth.js#sweep"
DATA p=3 ref=rect-register key="code" value="server/src/auth.js#register"
DATA p=3 ref=rect-register key="what" value="At least 10 characters, not containing the username. Rate limited: 5 sign-ups an hour per address."
DATA p=3 ref=rect-session key="code" value="server/src/auth.js#createSession"
DATA p=3 ref=rect-stepup key="code" value="server/src/auth.js#stepUp"
DATA p=3 ref=rect-ticket key="code" value="server/src/auth.js#beginLogin"
DATA p=3 ref=rect-toggle key="code" value="server/src/auth.js#confirmAction"
DATA p=4 ref=cylinder-queue key="code" value="server/src/compute/jobs.js#JobService"
DATA p=4 ref=diamond-deploy key="code" value="server/src/compute/ci.js#afterJob"
DATA p=4 ref=diamond-pair key="code" value="server/src/social/tasks.js#secondReaderFor"
DATA p=4 ref=ellipse-ci key="code" value="server/src/compute/ci.js#run"
DATA p=4 ref=ellipse-fn key="code" value="server/src/compute/functions.js#invoke"
DATA p=4 ref=ellipse-push key="code" value="server/src/git/http.js#serve"
DATA p=4 ref=rect-accept key="code" value="server/src/social/budgets.js#award"
DATA p=4 ref=rect-access key="code" value="server/src/git/projects.js#canWrite"
DATA p=4 ref=rect-claim key="code" value="server/src/social/tasks.js#claim"
DATA p=4 ref=rect-claim key="what" value="Not one of the two agents, not owned by either owner, and opted in to this kind of work."
DATA p=4 ref=rect-complete key="code" value="server/src/compute/ci.js#afterJob"
DATA p=4 ref=rect-credit key="code" value="server/src/social/agents.js#fromByline"
DATA p=4 ref=rect-fnrun key="code" value="runner/harness/node.mjs"
DATA p=4 ref=rect-pipeline key="code" value="server/src/compute/formats.js#normalizePipeline"
DATA p=4 ref=rect-quota key="code" value="server/src/billing/billing.js#reserve"
DATA p=4 ref=rect-record key="code" value="server/src/git/projects.js#afterPush"
DATA p=4 ref=rect-review key="code" value="server/src/social/tasks.js#submitReview"
DATA p=4 ref=rect-runnerclaim key="code" value="server/src/compute/jobs.js#claim"
DATA p=4 ref=rect-site key="code" value="server/src/hosting/sites.js#deploy"
DATA p=4 ref=rect-sr key="code" value="server/src/social/tasks.js#secondReaderFor"
DATA p=4 ref=rect-vm key="code" value="runner/lib/runner.js#executeJob"
DATA p=5 ref=diamond-remedy key="code" value="medic/lib/remedies.js"
DATA p=5 ref=ellipse-hub key="code" value="omni/lib/hub.js"
DATA p=5 ref=ellipse-timer key="code" value="deploy/gitcha-medic.timer"
DATA p=5 ref=rect-agent key="code" value="medic/lib/agent.js#consult"
DATA p=5 ref=rect-gw key="code" value="deploy/nginx-omni.conf.example"
DATA p=5 ref=rect-heal key="code" value="medic/lib/remedies.js"
DATA p=5 ref=rect-https key="code" value="omni/lib/remote.js"
DATA p=5 ref=rect-hubtools key="code" value="omni/lib/hub.js"
DATA p=5 ref=rect-label key="code" value="omni/lib/hub.js"
DATA p=5 ref=rect-members key="code" value="omni/lib/gateway.js"
DATA p=5 ref=rect-park key="code" value="medic/lib/remedies.js"
DATA p=5 ref=rect-probes key="code" value="medic/lib/probes.js"
DATA p=5 ref=rect-rules key="code" value="medic/lib/rules.js"
DATA p=5 ref=rect-tell key="code" value="medic/lib/channels.js#announce"
DOC name="How Gitcha works"
GAP p=1 kind=MAYBE_DEFAULT ref=internet-net what=label
GAP p=1 kind=NO_IP ref=database-cassandra
GAP p=1 kind=NO_IP ref=desktop-c4ok
GAP p=1 kind=NO_IP ref=laptop-cli
GAP p=1 kind=NO_IP ref=laptop-git
GAP p=1 kind=NO_IP ref=lb-proxy
GAP p=1 kind=NO_IP ref=nms-medic
GAP p=1 kind=NO_IP ref=server-gitcha
GAP p=1 kind=NO_IP ref=server-omni
GAP p=1 kind=NO_IP ref=server-runner
GAP p=1 kind=NO_IP ref=server-sshd
GAP p=1 kind=NO_IP ref=storage-data
GAP p=1 kind=NO_IP ref=user-agent
GAP p=1 kind=NO_IP ref=user-claude
GAP p=1 kind=NO_IP ref=users-browser
GAP p=1 kind=NO_IP ref=vm-bcontain
GAP p=1 kind=NO_SPEED ref=link-gitcha-cassandra
GAP p=1 kind=NO_SPEED ref=link-gitcha-data
GAP p=1 kind=NO_SPEED ref=link-gitcha-outside
GAP p=1 kind=NO_SPEED ref=link-medic-cassandra
GAP p=1 kind=NO_SPEED ref=link-medic-claudeapi
GAP p=1 kind=NO_SPEED ref=link-medic-gitcha
GAP p=1 kind=NO_SPEED ref=link-net-proxy
GAP p=1 kind=NO_SPEED ref=link-net-sshd
GAP p=1 kind=NO_SPEED ref=link-omni-gitcha
GAP p=1 kind=NO_SPEED ref=link-outside-proxy
GAP p=1 kind=NO_SPEED ref=link-people-net
GAP p=1 kind=NO_SPEED ref=link-proxy-gitcha
GAP p=1 kind=NO_SPEED ref=link-proxy-omni
GAP p=1 kind=NO_SPEED ref=link-runner-bcontain
GAP p=1 kind=NO_SPEED ref=link-runner-net
GAP p=1 kind=NO_SPEED ref=link-sshd-gitcha
GAP p=1 kind=NO_SUBNET ref=site-runners
GAP p=1 kind=NO_SUBNET ref=site-server
GAP p=1 kind=NO_SUBNET ref=zone-cassandra
GAP p=1 kind=NO_SUBNET ref=zone-outside
GAP p=1 kind=NO_SUBNET ref=zone-people
GAP p=2 kind=NO_SPEED ref=link-arrive-ip
GAP p=2 kind=NO_SPEED ref=link-guard-mfa
GAP p=2 kind=NO_SPEED ref=link-guard-service
GAP p=2 kind=NO_SPEED ref=link-hosted-hosted
GAP p=2 kind=NO_SPEED ref=link-hosted-xsite
GAP p=2 kind=NO_SPEED ref=link-ip-hosted
GAP p=2 kind=NO_SPEED ref=link-route-guard
GAP p=2 kind=NO_SPEED ref=link-service-reply
GAP p=2 kind=NO_SPEED ref=link-service-tx
GAP p=2 kind=NO_SPEED ref=link-tx-cass
GAP p=2 kind=NO_SPEED ref=link-tx-file
GAP p=2 kind=NO_SPEED ref=link-xsite-refuse
GAP p=2 kind=NO_SPEED ref=link-xsite-route
GAP p=2 kind=UNLABELED_LINK ref=link-arrive-ip
GAP p=2 kind=UNLABELED_LINK ref=link-ip-hosted
GAP p=2 kind=UNLABELED_LINK ref=link-route-guard
GAP p=2 kind=UNLABELED_LINK ref=link-service-reply
GAP p=3 kind=NO_SPEED ref=link-check-stepup
GAP p=3 kind=NO_SPEED ref=link-code-session
GAP p=3 kind=NO_SPEED ref=link-enroll-active
GAP p=3 kind=NO_SPEED ref=link-password-ticket
GAP p=3 kind=NO_SPEED ref=link-pending-enroll
GAP p=3 kind=NO_SPEED ref=link-register-pending
GAP p=3 kind=NO_SPEED ref=link-session-check
GAP p=3 kind=NO_SPEED ref=link-signin-password
GAP p=3 kind=NO_SPEED ref=link-signup-register
GAP p=3 kind=NO_SPEED ref=link-ticket-code
GAP p=3 kind=NO_SPEED ref=link-toggle-check
GAP p=3 kind=UNLABELED_LINK ref=link-pending-enroll
GAP p=3 kind=UNLABELED_LINK ref=link-register-pending
GAP p=3 kind=UNLABELED_LINK ref=link-signin-password
GAP p=3 kind=UNLABELED_LINK ref=link-signup-register
GAP p=3 kind=UNLABELED_LINK ref=link-ticket-code
GAP p=4 kind=NO_SPEED ref=link-access-record
GAP p=4 kind=NO_SPEED ref=link-ci-pipeline
GAP p=4 kind=NO_SPEED ref=link-claim-review
GAP p=4 kind=NO_SPEED ref=link-complete-deploy
GAP p=4 kind=NO_SPEED ref=link-credit-pair
GAP p=4 kind=NO_SPEED ref=link-deploy-site
GAP p=4 kind=NO_SPEED ref=link-fn-queue
GAP p=4 kind=NO_SPEED ref=link-pair-sr
GAP p=4 kind=NO_SPEED ref=link-pipeline-quota
GAP p=4 kind=NO_SPEED ref=link-push-access
GAP p=4 kind=NO_SPEED ref=link-queue-runnerclaim
GAP p=4 kind=NO_SPEED ref=link-quota-queue
GAP p=4 kind=NO_SPEED ref=link-record-credit
GAP p=4 kind=NO_SPEED ref=link-review-accept
GAP p=4 kind=NO_SPEED ref=link-runnerclaim-fnrun
GAP p=4 kind=NO_SPEED ref=link-runnerclaim-vm
GAP p=4 kind=NO_SPEED ref=link-sr-claim
GAP p=4 kind=NO_SPEED ref=link-vm-complete
GAP p=4 kind=UNLABELED_LINK ref=link-access-record
GAP p=4 kind=UNLABELED_LINK ref=link-ci-pipeline
GAP p=4 kind=UNLABELED_LINK ref=link-claim-review
GAP p=4 kind=UNLABELED_LINK ref=link-complete-deploy
GAP p=4 kind=UNLABELED_LINK ref=link-credit-pair
GAP p=4 kind=UNLABELED_LINK ref=link-pipeline-quota
GAP p=4 kind=UNLABELED_LINK ref=link-push-access
GAP p=4 kind=UNLABELED_LINK ref=link-queue-runnerclaim
GAP p=4 kind=UNLABELED_LINK ref=link-quota-queue
GAP p=4 kind=UNLABELED_LINK ref=link-record-credit
GAP p=4 kind=UNLABELED_LINK ref=link-review-accept
GAP p=4 kind=UNLABELED_LINK ref=link-runnerclaim-vm
GAP p=4 kind=UNLABELED_LINK ref=link-sr-claim
GAP p=4 kind=UNLABELED_LINK ref=link-vm-complete
GAP p=5 kind=NO_SPEED ref=link-agent-remedy
GAP p=5 kind=NO_SPEED ref=link-gw-members
GAP p=5 kind=NO_SPEED ref=link-heal-tell
GAP p=5 kind=NO_SPEED ref=link-https-gw
GAP p=5 kind=NO_SPEED ref=link-hub-hubtools
GAP p=5 kind=NO_SPEED ref=link-hubtools-https
GAP p=5 kind=NO_SPEED ref=link-members-label
GAP p=5 kind=NO_SPEED ref=link-park-tell
GAP p=5 kind=NO_SPEED ref=link-probes-rules
GAP p=5 kind=NO_SPEED ref=link-remedy-heal
GAP p=5 kind=NO_SPEED ref=link-remedy-park
GAP p=5 kind=NO_SPEED ref=link-rules-agent
GAP p=5 kind=NO_SPEED ref=link-rules-remedy
GAP p=5 kind=NO_SPEED ref=link-timer-probes
GAP p=5 kind=UNLABELED_LINK ref=link-gw-members
GAP p=5 kind=UNLABELED_LINK ref=link-heal-tell
GAP p=5 kind=UNLABELED_LINK ref=link-https-gw
GAP p=5 kind=UNLABELED_LINK ref=link-hub-hubtools
GAP p=5 kind=UNLABELED_LINK ref=link-hubtools-https
GAP p=5 kind=UNLABELED_LINK ref=link-members-label
GAP p=5 kind=UNLABELED_LINK ref=link-park-tell
GAP p=5 kind=UNLABELED_LINK ref=link-probes-rules
GAP p=5 kind=UNLABELED_LINK ref=link-rules-remedy
GAP p=5 kind=UNLABELED_LINK ref=link-timer-probes
IN p=1 ref=cloud-claudeapi parent=zone-outside
IN p=1 ref=cloud-dns parent=zone-outside
IN p=1 ref=cloud-nexttime parent=zone-outside
IN p=1 ref=cloud-paypal parent=zone-outside
IN p=1 ref=cloud-ring parent=zone-outside
IN p=1 ref=cloud-sandbox parent=zone-people
IN p=1 ref=cloud-stripe parent=zone-outside
IN p=1 ref=database-cassandra parent=zone-cassandra
IN p=1 ref=desktop-c4ok parent=zone-people
IN p=1 ref=laptop-cli parent=zone-people
IN p=1 ref=laptop-git parent=zone-people
IN p=1 ref=lb-proxy parent=site-server
IN p=1 ref=nms-medic parent=site-server
IN p=1 ref=server-gitcha parent=site-server
IN p=1 ref=server-omni parent=site-server
IN p=1 ref=server-runner parent=site-runners
IN p=1 ref=server-sshd parent=site-server
IN p=1 ref=storage-data parent=site-server
IN p=1 ref=user-agent parent=zone-people
IN p=1 ref=user-claude parent=zone-people
IN p=1 ref=users-browser parent=zone-people
IN p=1 ref=vm-bcontain parent=site-runners
LAYER p=1 n=1 visible=1 name="Drawing"
LAYER p=2 n=1 visible=1 name="Drawing"
LAYER p=3 n=1 visible=1 name="Drawing"
LAYER p=4 n=1 visible=1 name="Drawing"
LAYER p=5 n=1 visible=1 name="Drawing"
LINK p=1 ref=link-gitcha-cassandra a=server-gitcha b=database-cassandra label="GITCHA_STORE=cassandra"
LINK p=1 ref=link-gitcha-data a=server-gitcha b=storage-data label="file store, blobs, git, sites"
LINK p=1 ref=link-gitcha-outside a=server-gitcha b=zone-outside label="payments, NextTime, ring, DNS"
LINK p=1 ref=link-medic-cassandra a=nms-medic b=database-cassandra label="probes"
LINK p=1 ref=link-medic-claudeapi a=nms-medic b=cloud-claudeapi label="optional --ask"
LINK p=1 ref=link-medic-gitcha a=nms-medic b=server-gitcha label="probes"
LINK p=1 ref=link-net-proxy a=internet-net b=lb-proxy label="https 443"
LINK p=1 ref=link-net-sshd a=internet-net b=server-sshd label="ssh 22 (git only)"
LINK p=1 ref=link-omni-gitcha a=server-omni b=server-gitcha label="gitcha-mcp member"
LINK p=1 ref=link-outside-proxy a=zone-outside b=lb-proxy label="signed webhooks (Stripe, PayPal)"
LINK p=1 ref=link-people-net a=zone-people b=internet-net label="https (git: https or ssh)"
LINK p=1 ref=link-proxy-gitcha a=lb-proxy b=server-gitcha label="http to 127.0.0.1:4873"
LINK p=1 ref=link-proxy-omni a=lb-proxy b=server-omni label="/mcp/<member>"
LINK p=1 ref=link-runner-bcontain a=server-runner b=vm-bcontain label="one VM per job"
LINK p=1 ref=link-runner-net a=server-runner b=internet-net label="https: long-poll for jobs"
LINK p=1 ref=link-sshd-gitcha a=server-sshd b=server-gitcha label="/internal/git/* (loopback + internal.key)"
LINK p=2 ref=link-arrive-ip a=ellipse-arrive b=rect-ip label=""
LINK p=2 ref=link-guard-mfa a=diamond-guard b=rect-mfa label="check due"
LINK p=2 ref=link-guard-service a=diamond-guard b=rect-service label="ok"
LINK p=2 ref=link-hosted-hosted a=diamond-hosted b=rect-hosted label="yes"
LINK p=2 ref=link-hosted-xsite a=diamond-hosted b=diamond-xsite label="no"
LINK p=2 ref=link-ip-hosted a=rect-ip b=diamond-hosted label=""
LINK p=2 ref=link-route-guard a=rect-route b=diamond-guard label=""
LINK p=2 ref=link-service-reply a=rect-service b=rect-reply label=""
LINK p=2 ref=link-service-tx a=rect-service b=cylinder-tx label="change data"
LINK p=2 ref=link-tx-cass a=cylinder-tx b=cylinder-cass label="GITCHA_STORE=cassandra"
LINK p=2 ref=link-tx-file a=cylinder-tx b=cylinder-file label="GITCHA_STORE=file"
LINK p=2 ref=link-xsite-refuse a=diamond-xsite b=rect-refuse label="yes"
LINK p=2 ref=link-xsite-route a=diamond-xsite b=rect-route label="no"
LINK p=3 ref=link-check-stepup a=diamond-check b=rect-stepup label="yes"
LINK p=3 ref=link-code-session a=rect-code b=rect-session label="correct"
LINK p=3 ref=link-enroll-active a=rect-enroll b=rect-active label="code correct"
LINK p=3 ref=link-password-ticket a=rect-password b=rect-ticket label="correct"
LINK p=3 ref=link-pending-enroll a=rect-pending b=rect-enroll label=""
LINK p=3 ref=link-register-pending a=rect-register b=rect-pending label=""
LINK p=3 ref=link-session-check a=rect-session b=diamond-check label="each request"
LINK p=3 ref=link-signin-password a=ellipse-signin b=rect-password label=""
LINK p=3 ref=link-signup-register a=ellipse-signup b=rect-register label=""
LINK p=3 ref=link-ticket-code a=rect-ticket b=rect-code label=""
LINK p=3 ref=link-toggle-check a=rect-toggle b=diamond-check label="settings"
LINK p=4 ref=link-access-record a=rect-access b=rect-record label=""
LINK p=4 ref=link-ci-pipeline a=ellipse-ci b=rect-pipeline label=""
LINK p=4 ref=link-claim-review a=rect-claim b=rect-review label=""
LINK p=4 ref=link-complete-deploy a=rect-complete b=diamond-deploy label=""
LINK p=4 ref=link-credit-pair a=rect-credit b=diamond-pair label=""
LINK p=4 ref=link-deploy-site a=diamond-deploy b=rect-site label="yes"
LINK p=4 ref=link-fn-queue a=ellipse-fn b=cylinder-queue label="queued"
LINK p=4 ref=link-pair-sr a=diamond-pair b=rect-sr label="yes"
LINK p=4 ref=link-pipeline-quota a=rect-pipeline b=rect-quota label=""
LINK p=4 ref=link-push-access a=ellipse-push b=rect-access label=""
LINK p=4 ref=link-queue-runnerclaim a=cylinder-queue b=rect-runnerclaim label=""
LINK p=4 ref=link-quota-queue a=rect-quota b=cylinder-queue label=""
LINK p=4 ref=link-record-credit a=rect-record b=rect-credit label=""
LINK p=4 ref=link-review-accept a=rect-review b=rect-accept label=""
LINK p=4 ref=link-runnerclaim-fnrun a=rect-runnerclaim b=rect-fnrun label="kind fn"
LINK p=4 ref=link-runnerclaim-vm a=rect-runnerclaim b=rect-vm label=""
LINK p=4 ref=link-sr-claim a=rect-sr b=rect-claim label=""
LINK p=4 ref=link-vm-complete a=rect-vm b=rect-complete label=""
LINK p=5 ref=link-agent-remedy a=rect-agent b=diamond-remedy label="asks for a remedy"
LINK p=5 ref=link-gw-members a=rect-gw b=rect-members label=""
LINK p=5 ref=link-heal-tell a=rect-heal b=rect-tell label=""
LINK p=5 ref=link-https-gw a=rect-https b=rect-gw label=""
LINK p=5 ref=link-hub-hubtools a=ellipse-hub b=rect-hubtools label=""
LINK p=5 ref=link-hubtools-https a=rect-hubtools b=rect-https label=""
LINK p=5 ref=link-members-label a=rect-members b=rect-label label=""
LINK p=5 ref=link-park-tell a=rect-park b=rect-tell label=""
LINK p=5 ref=link-probes-rules a=rect-probes b=rect-rules label=""
LINK p=5 ref=link-remedy-heal a=diamond-remedy b=rect-heal label="yes"
LINK p=5 ref=link-remedy-park a=diamond-remedy b=rect-park label="no"
LINK p=5 ref=link-rules-agent a=rect-rules b=rect-agent label="--ask"
LINK p=5 ref=link-rules-remedy a=rect-rules b=diamond-remedy label=""
LINK p=5 ref=link-timer-probes a=ellipse-timer b=rect-probes label=""
NODE p=1 ref=cloud-claudeapi kind=device type=cloud label="Claude API (medic's agent)"
NODE p=1 ref=cloud-dns kind=device type=cloud label="DNS"
NODE p=1 ref=cloud-nexttime kind=device type=cloud label="NextTime-Dev"
NODE p=1 ref=cloud-paypal kind=device type=cloud label="PayPal"
NODE p=1 ref=cloud-ring kind=device type=cloud label="Other Gitchas (the ring)"
NODE p=1 ref=cloud-sandbox kind=device type=cloud label="Claude in a cloud sandbox (omni-hub)"
NODE p=1 ref=cloud-stripe kind=device type=cloud label="Stripe"
NODE p=1 ref=database-cassandra kind=device type=database label="Apache Cassandra"
NODE p=1 ref=desktop-c4ok kind=device type=desktop label="C4OK kiosk (staff)"
NODE p=1 ref=internet-net kind=device type=internet label="Internet"
NODE p=1 ref=laptop-cli kind=device type=laptop label="gitcha CLI"
NODE p=1 ref=laptop-git kind=device type=laptop label="git (HTTPS or SSH)"
NODE p=1 ref=lb-proxy kind=device type=lb label="Reverse proxy (TLS)"
NODE p=1 ref=nms-medic kind=device type=nms label="gitcha-medic (timer)"
NODE p=1 ref=server-gitcha kind=device type=server label="gitcha-server"
NODE p=1 ref=server-omni kind=device type=server label="omni-gateway"
NODE p=1 ref=server-runner kind=device type=server label="gitcha-runner"
NODE p=1 ref=server-sshd kind=device type=server label="sshd + gitcha-ssh-keys / gitcha-git-shell"
NODE p=1 ref=site-runners kind=container type=site label="Runner VM(s), apart from the server"
NODE p=1 ref=site-server kind=container type=site label="Gitcha server VM (alphaOS)"
NODE p=1 ref=storage-data kind=device type=storage label="Data folder /var/lib/gitcha"
NODE p=1 ref=text-title kind=basic type=text label="How Gitcha works: the whole system"
NODE p=1 ref=user-agent kind=device type=user label="Agents (for HUMAN, MODEL)"
NODE p=1 ref=user-claude kind=device type=user label="Claude + Gitcha extension"
NODE p=1 ref=users-browser kind=device type=users label="People in a browser"
NODE p=1 ref=vm-bcontain kind=device type=vm label="bContain VM, one per job"
NODE p=1 ref=zone-cassandra kind=container type=zone label="Cassandra cluster (optional)"
NODE p=1 ref=zone-outside kind=container type=zone label="Services Gitcha calls out to (https)"
NODE p=1 ref=zone-people kind=container type=zone label="People, agents and their tools"
NODE p=2 ref=cylinder-cass kind=basic type=cylinder label="Cassandra: changed rows, one batch, lease checked"
NODE p=2 ref=cylinder-file kind=basic type=cylinder label="File: db.json (temp file, fsync, rename)"
NODE p=2 ref=cylinder-tx kind=basic type=cylinder label="store.tx: saved whole, or not at all"
NODE p=2 ref=diamond-guard kind=basic type=diamond label="Guard: signed in, and no 2FA check due?"
NODE p=2 ref=diamond-hosted kind=basic type=diamond label="Is the Host a hosted site?"
NODE p=2 ref=diamond-xsite kind=basic type=diamond label="An /api/ call marked cross-site?"
NODE p=2 ref=ellipse-arrive kind=basic type=ellipse label="A request arrives from the proxy"
NODE p=2 ref=rect-hosted kind=basic type=rect label="serveHosted: files from the active deploy, or a function call"
NODE p=2 ref=rect-ip kind=basic type=rect label="Who is calling?"
NODE p=2 ref=rect-mfa kind=basic type=rect label="Answer mfa_required, or show \"Confirm it's you\""
NODE p=2 ref=rect-refuse kind=basic type=rect label="Refused"
NODE p=2 ref=rect-reply kind=basic type=rect label="Reply: JSON, or an HTML page built with h`...` (every value escaped), plus security headers (CSP)"
NODE p=2 ref=rect-route kind=basic type=rect label="Router finds the route"
NODE p=2 ref=rect-service kind=basic type=rect label="The service does the work (auth, packages, sites, jobs, billing, social, ops)"
NODE p=2 ref=text-title2 kind=basic type=text label="One request through gitcha-server"
NODE p=3 ref=diamond-check kind=basic type=diamond label="Later: is a check due?"
NODE p=3 ref=ellipse-signin kind=basic type=ellipse label="Sign in (web, CLI or C4OK)"
NODE p=3 ref=ellipse-signup kind=basic type=ellipse label="Sign up"
NODE p=3 ref=rect-active kind=basic type=rect label="Active, with 10 recovery codes (shown once, stored as keyed hashes)"
NODE p=3 ref=rect-code kind=basic type=rect label="A 6-digit code (each one works once)"
NODE p=3 ref=rect-enroll kind=basic type=rect label="Scan the QR code, type a code"
NODE p=3 ref=rect-password kind=basic type=rect label="Password checked (rate limits first, then scrypt)"
NODE p=3 ref=rect-pending kind=basic type=rect label="Account waits as pending_mfa (30 minutes)"
NODE p=3 ref=rect-register kind=basic type=rect label="Check name, password (twice), optional email (twice)"
NODE p=3 ref=rect-session kind=basic type=rect label="Session or device token (only its hash is stored)"
NODE p=3 ref=rect-stepup kind=basic type=rect label="Confirm it's you: a fresh code"
NODE p=3 ref=rect-ticket kind=basic type=rect label="A 5-minute ticket, not a session"
NODE p=3 ref=rect-toggle kind=basic type=rect label="Each person may turn the follow-up checks off with a code sent with that change; an admin can lock them on"
NODE p=3 ref=text-title3 kind=basic type=text label="Signing up, signing in, and the checks after"
NODE p=4 ref=cylinder-queue kind=basic type=cylinder label="The job queue"
NODE p=4 ref=diamond-deploy kind=basic type=diamond label="Passed, and asked to deploy?"
NODE p=4 ref=diamond-pair kind=basic type=diamond label="Two agents on the same branches within 7 days?"
NODE p=4 ref=ellipse-ci kind=basic type=ellipse label="A build starts: on publish, or POST /api/v1/ci/runs"
NODE p=4 ref=ellipse-fn kind=basic type=ellipse label="A function call: a site route or the invoke API"
NODE p=4 ref=ellipse-push kind=basic type=ellipse label="git push (person or agent)"
NODE p=4 ref=rect-accept kind=basic type=rect label="A maintainer (not the reviewer's owner) accepts: credits paid, capped per day"
NODE p=4 ref=rect-access kind=basic type=rect label="Read and write rights, 2FA; private projects answer 404"
NODE p=4 ref=rect-claim kind=basic type=rect label="An independent agent claims it (72 hours)"
NODE p=4 ref=rect-complete kind=basic type=rect label="Result reported; minutes counted once"
NODE p=4 ref=rect-credit kind=basic type=rect label="Credit each commit to the byline's agent (only the pusher's own) or to the pusher"
NODE p=4 ref=rect-fnrun kind=basic type=rect label="Queued like a build; a runner runs it in a harness (node, python, sh, orgvm, chain)"
NODE p=4 ref=rect-pipeline kind=basic type=rect label="Read the pipeline: gitcha-ci.json, .org, or a TopoForge drawing"
NODE p=4 ref=rect-quota kind=basic type=rect label="Deploy rights, queue room, billing quota; minutes or credits held"
NODE p=4 ref=rect-record kind=basic type=rect label="Record the push: new commits read from git objects, signatures checked against the pusher's keys"
NODE p=4 ref=rect-review kind=basic type=rect label="Verdict, summary, findings"
NODE p=4 ref=rect-runnerclaim kind=basic type=rect label="A runner long-polls and claims it (a job token for that job and runner only)"
NODE p=4 ref=rect-site kind=basic type=rect label="New deploy of the site; older ones kept for instant rollback"
NODE p=4 ref=rect-sr kind=basic type=rect label="Second Reader task opens (mirrored to NextTime for public projects)"
NODE p=4 ref=rect-vm kind=basic type=rect label="bContain VM runs the steps; the log streams back (5 MB cap)"
NODE p=4 ref=text-title4 kind=basic type=text label="How work moves: a push, a Second Reader review, a CI build, a deploy"
NODE p=5 ref=diamond-remedy kind=basic type=diamond label="A remedy that is safe?"
NODE p=5 ref=ellipse-hub kind=basic type=ellipse label="Claude in a cloud sandbox calls omni-hub (stdio)"
NODE p=5 ref=ellipse-timer kind=basic type=ellipse label="gitcha-medic.timer (or a person runs gitcha-medic)"
NODE p=5 ref=note-medicomni kind=basic type=note label="The medic also watches omni-gateway when it is installed."
NODE p=5 ref=rect-agent kind=basic type=rect label="Optional: ask a model about what the rules left unexplained (redacted facts only)"
NODE p=5 ref=rect-gw kind=basic type=rect label="nginx (TLS), then omni-gateway on 127.0.0.1:8769"
NODE p=5 ref=rect-heal kind=basic type=rect label="Run it (with --heal): start a stopped service, restart a stuck one"
NODE p=5 ref=rect-https kind=basic type=rect label="https with one bearer token per member (an environment secret, read per call)"
NODE p=5 ref=rect-hubtools kind=basic type=rect label="The hub offers every member's tools as its own, plus omni_status and skill_read"
NODE p=5 ref=rect-label kind=basic type=rect label="What a member answers is labelled as other people's text"
NODE p=5 ref=rect-members kind=basic type=rect label="One stdio child per member: gitcha-mcp, mentcached, persona, tavern, ..."
NODE p=5 ref=rect-park kind=basic type=rect label="Park it for a person (confirm class: --yes NAME)"
NODE p=5 ref=rect-probes kind=basic type=rect label="Probes read: services, journal, ports, health URL, Cassandra, the proxy"
NODE p=5 ref=rect-rules kind=basic type=rect label="Rules turn facts into findings, in plain words"
NODE p=5 ref=rect-tell kind=basic type=rect label="Tell syslog always, and the configured rooms (a change, or a heartbeat)"
NODE p=5 ref=text-title5 kind=basic type=text label="Keeping it running: the medic, and Omni"
PAGE p=1 name="1 The whole system"
PAGE p=2 name="2 One request"
PAGE p=3 name="3 Accounts and 2FA"
PAGE p=4 name="4 Push, review, build, deploy"
PAGE p=5 name="5 Keeping it running"
PROP p=1 ref=lb-proxy key=hostname value="gitcha.example.org"
PROP p=1 ref=lb-proxy key=notes value="Caddy, nginx, Apache or HAProxy. Owns ports 443 and 80 and the certificates; asks Gitcha before issuing one."
PROP p=1 ref=link-gitcha-cassandra key=medium value="logical"
PROP p=1 ref=link-gitcha-data key=medium value="logical"
PROP p=1 ref=link-gitcha-outside key=medium value="wan"
PROP p=1 ref=link-medic-cassandra key=medium value="logical"
PROP p=1 ref=link-medic-claudeapi key=medium value="wan"
PROP p=1 ref=link-medic-gitcha key=medium value="logical"
PROP p=1 ref=link-net-proxy key=medium value="wan"
PROP p=1 ref=link-net-sshd key=medium value="wan"
PROP p=1 ref=link-omni-gitcha key=medium value="logical"
PROP p=1 ref=link-outside-proxy key=medium value="wan"
PROP p=1 ref=link-people-net key=medium value="wan"
PROP p=1 ref=link-proxy-gitcha key=medium value="logical"
PROP p=1 ref=link-proxy-gitcha key=notes value="The proxy passes Host, X-Forwarded-For and X-Forwarded-Proto."
PROP p=1 ref=link-proxy-omni key=medium value="logical"
PROP p=1 ref=link-runner-bcontain key=medium value="logical"
PROP p=1 ref=link-runner-net key=medium value="wan"
PROP p=1 ref=link-runner-net key=notes value="Runner token for the runner; a job token for each job."
PROP p=1 ref=link-sshd-gitcha key=medium value="logical"
PROP p=1 ref=nms-medic key=notes value="Only reads to diagnose; runs a remedy only if its class is safe, or with --yes for a confirm one."
PROP p=1 ref=server-gitcha key=hostname value="127.0.0.1:4873"
PROP p=1 ref=server-gitcha key=notes value="Plain HTTP on loopback. Never runs user code."
PROP p=1 ref=server-omni key=hostname value="127.0.0.1:8769"
PROP p=1 ref=server-omni key=notes value="Behind the TLS proxy; one URL and one bearer token per member."
PROP p=1 ref=server-sshd key=notes value="A known key may only run gitcha-git-shell, which runs git-upload-pack or git-receive-pack and nothing else."
PROP p=1 ref=site-server key=notes value="Only the reverse proxy (and sshd, for git) listen on the network; everything else listens on loopback."
PROP p=1 ref=storage-data key=notes value="db.json (file store), secret.key, blobs/, git/, sites/, logs/, job-sources/, internal.key, db.lock"
PROP p=1 ref=vm-bcontain key=notes value="CPU and memory caps; nothing survives the job. Known gaps: outbound network, root inside, no disk quota."
PROP p=1 ref=zone-cassandra key=notes value="GITCHA_STORE=cassandra. The default build of the Debian package; --without-cassandra ships GITCHA_STORE=file."
PROP p=2 ref=link-arrive-ip key=medium value="logical"
PROP p=2 ref=link-guard-mfa key=medium value="logical"
PROP p=2 ref=link-guard-service key=medium value="logical"
PROP p=2 ref=link-hosted-hosted key=medium value="logical"
PROP p=2 ref=link-hosted-xsite key=medium value="logical"
PROP p=2 ref=link-ip-hosted key=medium value="logical"
PROP p=2 ref=link-route-guard key=medium value="logical"
PROP p=2 ref=link-service-reply key=medium value="logical"
PROP p=2 ref=link-service-tx key=medium value="logical"
PROP p=2 ref=link-tx-cass key=medium value="logical"
PROP p=2 ref=link-tx-file key=medium value="logical"
PROP p=2 ref=link-xsite-refuse key=medium value="logical"
PROP p=2 ref=link-xsite-route key=medium value="logical"
PROP p=3 ref=link-check-stepup key=medium value="logical"
PROP p=3 ref=link-code-session key=medium value="logical"
PROP p=3 ref=link-enroll-active key=medium value="logical"
PROP p=3 ref=link-password-ticket key=medium value="logical"
PROP p=3 ref=link-pending-enroll key=medium value="logical"
PROP p=3 ref=link-register-pending key=medium value="logical"
PROP p=3 ref=link-session-check key=medium value="logical"
PROP p=3 ref=link-signin-password key=medium value="logical"
PROP p=3 ref=link-signup-register key=medium value="logical"
PROP p=3 ref=link-ticket-code key=medium value="logical"
PROP p=3 ref=link-toggle-check key=medium value="logical"
PROP p=4 ref=link-access-record key=medium value="logical"
PROP p=4 ref=link-ci-pipeline key=medium value="logical"
PROP p=4 ref=link-claim-review key=medium value="logical"
PROP p=4 ref=link-complete-deploy key=medium value="logical"
PROP p=4 ref=link-credit-pair key=medium value="logical"
PROP p=4 ref=link-deploy-site key=medium value="logical"
PROP p=4 ref=link-fn-queue key=medium value="logical"
PROP p=4 ref=link-pair-sr key=medium value="logical"
PROP p=4 ref=link-pipeline-quota key=medium value="logical"
PROP p=4 ref=link-push-access key=medium value="logical"
PROP p=4 ref=link-queue-runnerclaim key=medium value="logical"
PROP p=4 ref=link-quota-queue key=medium value="logical"
PROP p=4 ref=link-record-credit key=medium value="logical"
PROP p=4 ref=link-review-accept key=medium value="logical"
PROP p=4 ref=link-runnerclaim-fnrun key=medium value="logical"
PROP p=4 ref=link-runnerclaim-vm key=medium value="logical"
PROP p=4 ref=link-sr-claim key=medium value="logical"
PROP p=4 ref=link-vm-complete key=medium value="logical"
PROP p=5 ref=link-agent-remedy key=medium value="logical"
PROP p=5 ref=link-gw-members key=medium value="logical"
PROP p=5 ref=link-heal-tell key=medium value="logical"
PROP p=5 ref=link-https-gw key=medium value="logical"
PROP p=5 ref=link-hub-hubtools key=medium value="logical"
PROP p=5 ref=link-hubtools-https key=medium value="logical"
PROP p=5 ref=link-members-label key=medium value="logical"
PROP p=5 ref=link-park-tell key=medium value="logical"
PROP p=5 ref=link-probes-rules key=medium value="logical"
PROP p=5 ref=link-remedy-heal key=medium value="logical"
PROP p=5 ref=link-remedy-park key=medium value="logical"
PROP p=5 ref=link-rules-agent key=medium value="logical"
PROP p=5 ref=link-rules-remedy key=medium value="logical"
PROP p=5 ref=link-timer-probes key=medium value="logical"
TEXT p=1 ref=text-title value="How Gitcha works: the whole system\nEvery program, the machine it runs on, and who talks to whom. Arrows point from the side that starts the conversation.\nEach shape's custom fields say what it does (what), where its code is (code) and how far it has been tested (status)."
TEXT p=2 ref=rect-ip value="Who is calling?\nclientIp"
TEXT p=2 ref=text-title2 value="One request through gitcha-server\nEvery HTTP request takes this path. The code fields name the function that does each step."
TEXT p=3 ref=text-title3 value="Signing up, signing in, and the checks after\nA password alone never signs anyone in. Passwords are scrypt-hashed and then encrypted; authenticator secrets and emails are encrypted; tokens are stored only as hashes."
TEXT p=4 ref=text-title4 value="How work moves: a push, a Second Reader review, a CI build, a deploy\nThe server queues work; only runners run it."
TEXT p=5 ref=text-title5 value="Keeping it running: the medic, and Omni\nThe medic only reads to diagnose, and mends only what is safe. Omni lets a Claude session in a cloud sandbox reach tools a person runs on their own hosts."
TOP p=1 ref=internet-net
TOP p=1 ref=site-runners
TOP p=1 ref=site-server
TOP p=1 ref=text-title
TOP p=1 ref=zone-cassandra
TOP p=1 ref=zone-outside
TOP p=1 ref=zone-people
TOP p=2 ref=cylinder-cass
TOP p=2 ref=cylinder-file
TOP p=2 ref=cylinder-tx
TOP p=2 ref=diamond-guard
TOP p=2 ref=diamond-hosted
TOP p=2 ref=diamond-xsite
TOP p=2 ref=ellipse-arrive
TOP p=2 ref=rect-hosted
TOP p=2 ref=rect-ip
TOP p=2 ref=rect-mfa
TOP p=2 ref=rect-refuse
TOP p=2 ref=rect-reply
TOP p=2 ref=rect-route
TOP p=2 ref=rect-service
TOP p=2 ref=text-title2
TOP p=3 ref=diamond-check
TOP p=3 ref=ellipse-signin
TOP p=3 ref=ellipse-signup
TOP p=3 ref=rect-active
TOP p=3 ref=rect-code
TOP p=3 ref=rect-enroll
TOP p=3 ref=rect-password
TOP p=3 ref=rect-pending
TOP p=3 ref=rect-register
TOP p=3 ref=rect-session
TOP p=3 ref=rect-stepup
TOP p=3 ref=rect-ticket
TOP p=3 ref=rect-toggle
TOP p=3 ref=text-title3
TOP p=4 ref=cylinder-queue
TOP p=4 ref=diamond-deploy
TOP p=4 ref=diamond-pair
TOP p=4 ref=ellipse-ci
TOP p=4 ref=ellipse-fn
TOP p=4 ref=ellipse-push
TOP p=4 ref=rect-accept
TOP p=4 ref=rect-access
TOP p=4 ref=rect-claim
TOP p=4 ref=rect-complete
TOP p=4 ref=rect-credit
TOP p=4 ref=rect-fnrun
TOP p=4 ref=rect-pipeline
TOP p=4 ref=rect-quota
TOP p=4 ref=rect-record
TOP p=4 ref=rect-review
TOP p=4 ref=rect-runnerclaim
TOP p=4 ref=rect-site
TOP p=4 ref=rect-sr
TOP p=4 ref=rect-vm
TOP p=4 ref=text-title4
TOP p=5 ref=diamond-remedy
TOP p=5 ref=ellipse-hub
TOP p=5 ref=ellipse-timer
TOP p=5 ref=note-medicomni
TOP p=5 ref=rect-agent
TOP p=5 ref=rect-gw
TOP p=5 ref=rect-heal
TOP p=5 ref=rect-https
TOP p=5 ref=rect-hubtools
TOP p=5 ref=rect-label
TOP p=5 ref=rect-members
TOP p=5 ref=rect-park
TOP p=5 ref=rect-probes
TOP p=5 ref=rect-rules
TOP p=5 ref=rect-tell
TOP p=5 ref=text-title5
```

## Story

### Page 1 "1 The whole system"

- Page 1, "1 The whole system": 23 devices, 5 groups, 1 other shape, 16 connections. [page-1]

#### Outside in

- "Claude API \(medic's agent\)" is a Cloud (TopoForge files this type as: outside world). [cloud-claudeapi]
- "Claude in a cloud sandbox \(omni-hub\)" is a Cloud (TopoForge files this type as: outside world). [cloud-sandbox]
- "DNS" is a Cloud (TopoForge files this type as: outside world). [cloud-dns]
- "Internet" is an Internet (TopoForge files this type as: outside world). [internet-net]
- "NextTime-Dev" is a Cloud (TopoForge files this type as: outside world). [cloud-nexttime]
- "Other Gitchas \(the ring\)" is a Cloud (TopoForge files this type as: outside world). [cloud-ring]
- "PayPal" is a Cloud (TopoForge files this type as: outside world). [cloud-paypal]
- "Stripe" is a Cloud (TopoForge files this type as: outside world). [cloud-stripe]
- "Reverse proxy \(TLS\)" is a Load Balancer (TopoForge files this type as: core); stated: hostname "gitcha.example.org" and notes "Caddy, nginx, Apache or HAProxy. Owns ports 443 and 80 and the certificates; asks Gitcha before issuing one.". [lb-proxy]
- "Apache Cassandra" is a Database (TopoForge files this type as: server). [database-cassandra]
- "Data folder /var/lib/gitcha" is a NAS / Storage (TopoForge files this type as: server); stated: notes "db.json \(file store\), secret.key, blobs/, git/, sites/, logs/, job-sources/, internal.key, db.lock". [storage-data]
- "bContain VM, one per job" is a Virtual Machine (TopoForge files this type as: server); stated: notes "CPU and memory caps; nothing survives the job. Known gaps: outbound network, root inside, no disk quota.". [vm-bcontain]
- "gitcha-medic \(timer\)" is a Monitoring (TopoForge files this type as: server); stated: notes "Only reads to diagnose; runs a remedy only if its class is safe, or with --yes for a confirm one.". [nms-medic]
- "gitcha-runner" is a Server (TopoForge files this type as: server). [server-runner]
- "gitcha-server" is a Server (TopoForge files this type as: server); stated: hostname "127.0.0.1:4873" and notes "Plain HTTP on loopback. Never runs user code.". [server-gitcha]
- "omni-gateway" is a Server (TopoForge files this type as: server); stated: hostname "127.0.0.1:8769" and notes "Behind the TLS proxy; one URL and one bearer token per member.". [server-omni]
- "sshd + gitcha-ssh-keys / gitcha-git-shell" is a Server (TopoForge files this type as: server); stated: notes "A known key may only run gitcha-git-shell, which runs git-upload-pack or git-receive-pack and nothing else.". [server-sshd]
- "Agents \(for HUMAN, MODEL\)" is a User (TopoForge files this type as: endpoint). [user-agent]
- "C4OK kiosk \(staff\)" is a Desktop PC (TopoForge files this type as: endpoint). [desktop-c4ok]
- "Claude + Gitcha extension" is a User (TopoForge files this type as: endpoint). [user-claude]
- "People in a browser" is a User Group (TopoForge files this type as: endpoint). [users-browser]
- "git \(HTTPS or SSH\)" is a Laptop (TopoForge files this type as: endpoint). [laptop-git]
- "gitcha CLI" is a Laptop (TopoForge files this type as: endpoint). [laptop-cli]

#### Groups

- "Cassandra cluster \(optional\)" is a Zone group; stated: notes "GITCHA\_STORE=cassandra. The default build of the Debian package; --without-cassandra ships GITCHA\_STORE=file.". It holds "Apache Cassandra". It is not inside any other group. [zone-cassandra, database-cassandra]
- "Gitcha server VM \(alphaOS\)" is a Site / Building group; stated: notes "Only the reverse proxy \(and sshd, for git\) listen on the network; everything else listens on loopback.". It holds "Data folder /var/lib/gitcha", "Reverse proxy \(TLS\)", "gitcha-medic \(timer\)", "gitcha-server", "omni-gateway" and "sshd + gitcha-ssh-keys / gitcha-git-shell". It is not inside any other group. [site-server, storage-data, lb-proxy, nms-medic, server-gitcha, server-omni, server-sshd]
- "People, agents and their tools" is a Zone group. It holds "Agents \(for HUMAN, MODEL\)", "C4OK kiosk \(staff\)", "Claude + Gitcha extension", "Claude in a cloud sandbox \(omni-hub\)", "People in a browser", "git \(HTTPS or SSH\)" and "gitcha CLI". It is not inside any other group. [zone-people, user-agent, desktop-c4ok, user-claude, cloud-sandbox, users-browser, laptop-git, laptop-cli]
- "Runner VM\(s\), apart from the server" is a Site / Building group. It holds "bContain VM, one per job" and "gitcha-runner". It is not inside any other group. [site-runners, vm-bcontain, server-runner]
- "Services Gitcha calls out to \(https\)" is a Zone group. It holds "Claude API \(medic's agent\)", "DNS", "NextTime-Dev", "Other Gitchas \(the ring\)", "PayPal" and "Stripe". It is not inside any other group. [zone-outside, cloud-claudeapi, cloud-dns, cloud-nexttime, cloud-ring, cloud-paypal, cloud-stripe]
- Not inside any group: "How Gitcha works: the whole system" and "Internet". [text-title, internet-net]

#### Other shapes

- "How Gitcha works: the whole system" is a Text shape; full text "How Gitcha works: the whole system\nEvery program, the machine it runs on, and who talks to whom. Arrows point from the side that starts the conversation.\nEach shape's custom fields say what it does \(what\), where its code is \(code\) and how far it has been tested \(status\).". [text-title]

#### Connections

- "gitcha-server" connects to "Apache Cassandra" over Logical; speed not given; labelled "GITCHA\_STORE=cassandra". [link-gitcha-cassandra, server-gitcha, database-cassandra]
- "gitcha-server" connects to "Data folder /var/lib/gitcha" over Logical; speed not given; labelled "file store, blobs, git, sites". [link-gitcha-data, server-gitcha, storage-data]
- "gitcha-server" connects to "Services Gitcha calls out to \(https\)" over WAN / Carrier; speed not given; labelled "payments, NextTime, ring, DNS". [link-gitcha-outside, server-gitcha, zone-outside]
- "gitcha-medic \(timer\)" connects to "Apache Cassandra" over Logical; speed not given; labelled "probes". [link-medic-cassandra, nms-medic, database-cassandra]
- "gitcha-medic \(timer\)" connects to "Claude API \(medic's agent\)" over WAN / Carrier; speed not given; labelled "optional --ask". [link-medic-claudeapi, nms-medic, cloud-claudeapi]
- "gitcha-medic \(timer\)" connects to "gitcha-server" over Logical; speed not given; labelled "probes". [link-medic-gitcha, nms-medic, server-gitcha]
- "Internet" connects to "Reverse proxy \(TLS\)" over WAN / Carrier; speed not given; labelled "https 443". [link-net-proxy, internet-net, lb-proxy]
- "Internet" connects to "sshd + gitcha-ssh-keys / gitcha-git-shell" over WAN / Carrier; speed not given; labelled "ssh 22 \(git only\)". [link-net-sshd, internet-net, server-sshd]
- "omni-gateway" connects to "gitcha-server" over Logical; speed not given; labelled "gitcha-mcp member". [link-omni-gitcha, server-omni, server-gitcha]
- "Services Gitcha calls out to \(https\)" connects to "Reverse proxy \(TLS\)" over WAN / Carrier; speed not given; labelled "signed webhooks \(Stripe, PayPal\)". [link-outside-proxy, zone-outside, lb-proxy]
- "People, agents and their tools" connects to "Internet" over WAN / Carrier; speed not given; labelled "https \(git: https or ssh\)". [link-people-net, zone-people, internet-net]
- "Reverse proxy \(TLS\)" connects to "gitcha-server" over Logical; speed not given; labelled "http to 127.0.0.1:4873"; stated: notes "The proxy passes Host, X-Forwarded-For and X-Forwarded-Proto.". [link-proxy-gitcha, lb-proxy, server-gitcha]
- "Reverse proxy \(TLS\)" connects to "omni-gateway" over Logical; speed not given; labelled "/mcp/\<member\>". [link-proxy-omni, lb-proxy, server-omni]
- "gitcha-runner" connects to "bContain VM, one per job" over Logical; speed not given; labelled "one VM per job". [link-runner-bcontain, server-runner, vm-bcontain]
- "gitcha-runner" connects to "Internet" over WAN / Carrier; speed not given; labelled "https: long-poll for jobs"; stated: notes "Runner token for the runner; a job token for each job.". [link-runner-net, server-runner, internet-net]
- "sshd + gitcha-ssh-keys / gitcha-git-shell" connects to "gitcha-server" over Logical; speed not given; labelled "/internal/git/\* \(loopback + internal.key\)". [link-sshd-gitcha, server-sshd, server-gitcha]

#### Custom fields

- Custom field "code" on "Claude API \(medic's agent\)" is "medic/lib/agent.js". [cloud-claudeapi]
- Custom field "status" on "Claude API \(medic's agent\)" is "built; tested only against stand-ins, not yet run for real". [cloud-claudeapi]
- Custom field "what" on "Claude API \(medic's agent\)" is "Optional: the medic shows a model the redacted findings; it may only ask for safe remedies.". [cloud-claudeapi]
- Custom field "code" on "DNS" is "server/src/hosting/domains.js". [cloud-dns]
- Custom field "status" on "DNS" is "built and tested". [cloud-dns]
- Custom field "what" on "DNS" is "TXT records at \_gitcha-challenge.NAME prove a custom domain.". [cloud-dns]
- Custom field "code" on "NextTime-Dev" is "server/src/social/nexttime.js". [cloud-nexttime]
- Custom field "status" on "NextTime-Dev" is "built; tested only against stand-ins, not yet run for real". [cloud-nexttime]
- Custom field "what" on "NextTime-Dev" is "Public projects' tasks become timebank requests: created, cancelled, completed.". [cloud-nexttime]
- Custom field "code" on "PayPal" is "server/src/billing/paypal.js". [cloud-paypal]
- Custom field "status" on "PayPal" is "built; tested only against stand-ins, not yet run for real". [cloud-paypal]
- Custom field "what" on "PayPal" is "Subscriptions; webhooks checked by asking PayPal.". [cloud-paypal]
- Custom field "code" on "Other Gitchas \(the ring\)" is "server/src/hosting/ring.js". [cloud-ring]
- Custom field "status" on "Other Gitchas \(the ring\)" is "built and tested". [cloud-ring]
- Custom field "what" on "Other Gitchas \(the ring\)" is "Each publishes /.well-known/gitcha-ring.json; only public addresses are fetched.". [cloud-ring]
- Custom field "code" on "Claude in a cloud sandbox \(omni-hub\)" is "omni/lib/hub.js". [cloud-sandbox]
- Custom field "status" on "Claude in a cloud sandbox \(omni-hub\)" is "built and tested; not yet run against a real cloud session". [cloud-sandbox]
- Custom field "what" on "Claude in a cloud sandbox \(omni-hub\)" is "Omni's hub: one stdio MCP server in a cloud session that reaches the tools a person runs on their own hosts.". [cloud-sandbox]
- Custom field "code" on "Stripe" is "server/src/billing/stripe.js". [cloud-stripe]
- Custom field "status" on "Stripe" is "built; tested only against stand-ins, not yet run for real". [cloud-stripe]
- Custom field "what" on "Stripe" is "Checkout, portal, webhooks checked by HMAC on the exact bytes.". [cloud-stripe]
- Custom field "code" on "Apache Cassandra" is "server/src/store-cassandra.js". [database-cassandra]
- Custom field "status" on "Apache Cassandra" is "built, tested, and run for real on Cassandra 5.0.9". [database-cassandra]
- Custom field "what" on "Apache Cassandra" is "The database, one row per entry; each save is one batch applied whole or not at all. A lease row stops two servers writing.". [database-cassandra]
- Custom field "code" on "C4OK kiosk \(staff\)" is "c4ok-PRIVATE w/lib/gitcha.js". [desktop-c4ok]
- Custom field "status" on "C4OK kiosk \(staff\)" is "built; not yet run inside a full C4OK runtime". [desktop-c4ok]
- Custom field "what" on "C4OK kiosk \(staff\)" is "The operations door: tickets and changes, with a console key read from a mode-600 file. Asks for a code whenever Gitcha does.". [desktop-c4ok]
- Custom field "what" on "Internet" is "Everything outside the server VM. Only the proxy \(and sshd, for git\) face it.". [internet-net]
- Custom field "code" on "gitcha CLI" is "extension/bin/gitcha.js". [laptop-cli]
- Custom field "status" on "gitcha CLI" is "built and tested". [laptop-cli]
- Custom field "what" on "gitcha CLI" is "Signs in once \(password + code\), keeps a device token \(mode 600\), publishes and installs packages.". [laptop-cli]
- Custom field "code" on "git \(HTTPS or SSH\)" is "server/src/git/http.js". [laptop-git]
- Custom field "status" on "git \(HTTPS or SSH\)" is "HTTPS: built and tested. SSH: built; tested only against stand-ins, not yet run for real". [laptop-git]
- Custom field "what" on "git \(HTTPS or SSH\)" is "Plain git: clone and push projects. HTTPS uses a console key as the password; SSH uses a registered key.". [laptop-git]
- Custom field "code" on "Reverse proxy \(TLS\)" is "deploy/Caddyfile.example". [lb-proxy]
- Custom field "status" on "Reverse proxy \(TLS\)" is "built and tested". [lb-proxy]
- Custom field "what" on "Reverse proxy \(TLS\)" is "Does https, sets X-Forwarded-For and X-Forwarded-Proto, and asks /api/v1/hosting/tls-allowed before any certificate.". [lb-proxy]
- Custom field "code" on "gitcha-medic \(timer\)" is "medic/bin/gitcha-medic.js". [nms-medic]
- Custom field "status" on "gitcha-medic \(timer\)" is "built; tested against stand-ins, not yet run on a real host". [nms-medic]
- Custom field "what" on "gitcha-medic \(timer\)" is "Looks at Gitcha, Cassandra and the proxy; says what is wrong and why; mends what is safe; tells syslog and the configured rooms.". [nms-medic]
- Custom field "code" on "gitcha-server" is "server/src/app.js\#createApp". [server-gitcha]
- Custom field "status" on "gitcha-server" is "built and tested". [server-gitcha]
- Custom field "what" on "gitcha-server" is "Accounts and 2FA, packages, teams, git, sites, CI and function queue, billing, the social side, GraphQL, tickets and changes.". [server-gitcha]
- Custom field "code" on "omni-gateway" is "omni/lib/gateway.js". [server-omni]
- Custom field "status" on "omni-gateway" is "built and tested; not yet run against a real vibrobeast server". [server-omni]
- Custom field "what" on "omni-gateway" is "Puts stdio MCP servers on this host \(gitcha-mcp, mentcached, persona, tavern\) behind HTTP for a cloud session.". [server-omni]
- Custom field "code" on "gitcha-runner" is "runner/lib/runner.js\#loop". [server-runner]
- Custom field "status" on "gitcha-runner" is "built and tested". [server-runner]
- Custom field "what" on "gitcha-runner" is "Registers once \(a token that works once\), long-polls for jobs, runs each one, streams the log, reports the result.". [server-runner]
- Custom field "code" on "sshd + gitcha-ssh-keys / gitcha-git-shell" is "server/bin/gitcha-git-shell.js". [server-sshd]
- Custom field "status" on "sshd + gitcha-ssh-keys / gitcha-git-shell" is "built; tested only against stand-ins, not yet run for real". [server-sshd]
- Custom field "what" on "sshd + gitcha-ssh-keys / gitcha-git-shell" is "Git over SSH. The helpers ask gitcha-server on loopback, with the secret in internal.key.". [server-sshd]
- Custom field "code" on "Data folder /var/lib/gitcha" is "server/src/store.js\#Store". [storage-data]
- Custom field "status" on "Data folder /var/lib/gitcha" is "built and tested". [storage-data]
- Custom field "what" on "Data folder /var/lib/gitcha" is "Everything the server keeps on disk. Back up secret.key apart from the rest.". [storage-data]
- Custom field "code" on "Agents \(for HUMAN, MODEL\)" is "server/src/social/agents.js". [user-agent]
- Custom field "status" on "Agents \(for HUMAN, MODEL\)" is "built and tested". [user-agent]
- Custom field "what" on "Agents \(for HUMAN, MODEL\)" is "Registered agents push with git \(their handle + the owner's console key, or their own SSH key\) and do Second Reader reviews.". [user-agent]
- Custom field "code" on "Claude + Gitcha extension" is "extension/bin/gitcha-mcp.js". [user-claude]
- Custom field "status" on "Claude + Gitcha extension" is "built and tested". [user-claude]
- Custom field "what" on "Claude + Gitcha extension" is "The MCP server Claude calls. Reuses the CLI's device token, so Claude never sees a password; asks the person for 2FA codes.". [user-claude]
- Custom field "code" on "People in a browser" is "server/src/web.js". [users-browser]
- Custom field "status" on "People in a browser" is "built and tested". [users-browser]
- Custom field "what" on "People in a browser" is "Sign up \(password + authenticator app\), browse, post to the crawl, manage teams, sites, keys and billing.". [users-browser]
- Custom field "code" on "bContain VM, one per job" is "runner/lib/backends/bcontain.js". [vm-bcontain]
- Custom field "status" on "bContain VM, one per job" is "built; tested only against stand-ins, not yet run for real". [vm-bcontain]
- Custom field "what" on "bContain VM, one per job" is "Runs one CI build or function call. Files arrive over QEMU's gateway \(10.0.2.2\) behind a random token for that job.". [vm-bcontain]

### Page 2 "2 One request"

- Page 2, "2 One request": 0 devices, 0 groups, 15 other shapes, 13 connections. [page-2]

#### Other shapes

- "A request arrives from the proxy" is an Ellipse shape. [ellipse-arrive]
- "An /api/ call marked cross-site?" is a Diamond shape. [diamond-xsite]
- "Answer mfa\_required, or show \"Confirm it's you\"" is a Rectangle shape. [rect-mfa]
- "Cassandra: changed rows, one batch, lease checked" is a Cylinder shape. [cylinder-cass]
- "File: db.json \(temp file, fsync, rename\)" is a Cylinder shape. [cylinder-file]
- "Guard: signed in, and no 2FA check due?" is a Diamond shape. [diamond-guard]
- "Is the Host a hosted site?" is a Diamond shape. [diamond-hosted]
- "One request through gitcha-server" is a Text shape; full text "One request through gitcha-server\nEvery HTTP request takes this path. The code fields name the function that does each step.". [text-title2]
- "Refused" is a Rectangle shape. [rect-refuse]
- "Reply: JSON, or an HTML page built with h\`...\` \(every value escaped\), plus security headers \(CSP\)" is a Rectangle shape. [rect-reply]
- "Router finds the route" is a Rectangle shape. [rect-route]
- "The service does the work \(auth, packages, sites, jobs, billing, social, ops\)" is a Rectangle shape. [rect-service]
- "Who is calling?" is a Rectangle shape; full text "Who is calling?\nclientIp". [rect-ip]
- "serveHosted: files from the active deploy, or a function call" is a Rectangle shape. [rect-hosted]
- "store.tx: saved whole, or not at all" is a Cylinder shape. [cylinder-tx]

#### Connections

- "A request arrives from the proxy" connects to "Who is calling?" over Logical; speed not given. [link-arrive-ip, ellipse-arrive, rect-ip]
- "Guard: signed in, and no 2FA check due?" connects to "Answer mfa\_required, or show \"Confirm it's you\"" over Logical; speed not given; labelled "check due". [link-guard-mfa, diamond-guard, rect-mfa]
- "Guard: signed in, and no 2FA check due?" connects to "The service does the work \(auth, packages, sites, jobs, billing, social, ops\)" over Logical; speed not given; labelled "ok". [link-guard-service, diamond-guard, rect-service]
- "Is the Host a hosted site?" connects to "serveHosted: files from the active deploy, or a function call" over Logical; speed not given; labelled "yes". [link-hosted-hosted, diamond-hosted, rect-hosted]
- "Is the Host a hosted site?" connects to "An /api/ call marked cross-site?" over Logical; speed not given; labelled "no". [link-hosted-xsite, diamond-hosted, diamond-xsite]
- "Who is calling?" connects to "Is the Host a hosted site?" over Logical; speed not given. [link-ip-hosted, rect-ip, diamond-hosted]
- "Router finds the route" connects to "Guard: signed in, and no 2FA check due?" over Logical; speed not given. [link-route-guard, rect-route, diamond-guard]
- "The service does the work \(auth, packages, sites, jobs, billing, social, ops\)" connects to "Reply: JSON, or an HTML page built with h\`...\` \(every value escaped\), plus security headers \(CSP\)" over Logical; speed not given. [link-service-reply, rect-service, rect-reply]
- "The service does the work \(auth, packages, sites, jobs, billing, social, ops\)" connects to "store.tx: saved whole, or not at all" over Logical; speed not given; labelled "change data". [link-service-tx, rect-service, cylinder-tx]
- "store.tx: saved whole, or not at all" connects to "Cassandra: changed rows, one batch, lease checked" over Logical; speed not given; labelled "GITCHA\_STORE=cassandra". [link-tx-cass, cylinder-tx, cylinder-cass]
- "store.tx: saved whole, or not at all" connects to "File: db.json \(temp file, fsync, rename\)" over Logical; speed not given; labelled "GITCHA\_STORE=file". [link-tx-file, cylinder-tx, cylinder-file]
- "An /api/ call marked cross-site?" connects to "Refused" over Logical; speed not given; labelled "yes". [link-xsite-refuse, diamond-xsite, rect-refuse]
- "An /api/ call marked cross-site?" connects to "Router finds the route" over Logical; speed not given; labelled "no". [link-xsite-route, diamond-xsite, rect-route]

#### Custom fields

- Custom field "code" on "Cassandra: changed rows, one batch, lease checked" is "server/src/store-cassandra.js". [cylinder-cass]
- Custom field "code" on "File: db.json \(temp file, fsync, rename\)" is "server/src/store.js\#writeFileDurably". [cylinder-file]
- Custom field "code" on "store.tx: saved whole, or not at all" is "server/src/store.js\#tx". [cylinder-tx]
- Custom field "what" on "store.tx: saved whole, or not at all" is "If the change throws partway or the write fails, memory goes back to the last save.". [cylinder-tx]
- Custom field "code" on "Guard: signed in, and no 2FA check due?" is "server/src/api.js\#makeGuards". [diamond-guard]
- Custom field "what" on "Guard: signed in, and no 2FA check due?" is "verified\(ctx\); verified\(ctx, \{ sensitive: true \}\) adds the 10-minute rule.". [diamond-guard]
- Custom field "code" on "Is the Host a hosted site?" is "server/src/hosting/sites.js\#siteForHost". [diamond-hosted]
- Custom field "code" on "An /api/ call marked cross-site?" is "server/src/app.js\#createApp". [diamond-xsite]
- Custom field "code" on "A request arrives from the proxy" is "server/src/app.js\#createApp". [ellipse-arrive]
- Custom field "what" on "A request arrives from the proxy" is "One handler in createApp takes every request.". [ellipse-arrive]
- Custom field "code" on "serveHosted: files from the active deploy, or a function call" is "server/src/hosting/api.js\#serveHosted". [rect-hosted]
- Custom field "what" on "serveHosted: files from the active deploy, or a function call" is "Hosted names never reach the Gitcha pages or APIs, so a user's site cannot act as the person viewing it.". [rect-hosted]
- Custom field "code" on "Who is calling?" is "server/src/http.js\#clientIp". [rect-ip]
- Custom field "what" on "Who is calling?" is "Behind a trusted proxy, believe only the X-Forwarded-For entry the nearest trusted proxy added.". [rect-ip]
- Custom field "code" on "Answer mfa\_required, or show \"Confirm it's you\"" is "server/src/auth.js\#mfaState". [rect-mfa]
- Custom field "what" on "Answer mfa\_required, or show \"Confirm it's you\"" is "interval \(12 h\), new\_network, sensitive \(10 min\). An admin can lock any of them on.". [rect-mfa]
- Custom field "what" on "Refused" is "A browser said another site sent it \(Sec-Fetch-Site: cross-site\).". [rect-refuse]
- Custom field "code" on "Reply: JSON, or an HTML page built with h\`...\` \(every value escaped\), plus security headers \(CSP\)" is "server/src/http.js\#send". [rect-reply]
- Custom field "code" on "Router finds the route" is "server/src/http.js\#Router". [rect-route]
- Custom field "code" on "The service does the work \(auth, packages, sites, jobs, billing, social, ops\)" is "server/src/app.js\#createApp". [rect-service]

### Page 3 "3 Accounts and 2FA"

- Page 3, "3 Accounts and 2FA": 0 devices, 0 groups, 14 other shapes, 11 connections. [page-3]

#### Other shapes

- "A 5-minute ticket, not a session" is a Rectangle shape. [rect-ticket]
- "A 6-digit code \(each one works once\)" is a Rectangle shape. [rect-code]
- "Account waits as pending\_mfa \(30 minutes\)" is a Rectangle shape. [rect-pending]
- "Active, with 10 recovery codes \(shown once, stored as keyed hashes\)" is a Rectangle shape. [rect-active]
- "Check name, password \(twice\), optional email \(twice\)" is a Rectangle shape. [rect-register]
- "Confirm it's you: a fresh code" is a Rectangle shape. [rect-stepup]
- "Each person may turn the follow-up checks off with a code sent with that change; an admin can lock them on" is a Rectangle shape. [rect-toggle]
- "Later: is a check due?" is a Diamond shape. [diamond-check]
- "Password checked \(rate limits first, then scrypt\)" is a Rectangle shape. [rect-password]
- "Scan the QR code, type a code" is a Rectangle shape. [rect-enroll]
- "Session or device token \(only its hash is stored\)" is a Rectangle shape. [rect-session]
- "Sign in \(web, CLI or C4OK\)" is an Ellipse shape. [ellipse-signin]
- "Sign up" is an Ellipse shape. [ellipse-signup]
- "Signing up, signing in, and the checks after" is a Text shape; full text "Signing up, signing in, and the checks after\nA password alone never signs anyone in. Passwords are scrypt-hashed and then encrypted; authenticator secrets and emails are encrypted; tokens are stored only as hashes.". [text-title3]

#### Connections

- "Later: is a check due?" connects to "Confirm it's you: a fresh code" over Logical; speed not given; labelled "yes". [link-check-stepup, diamond-check, rect-stepup]
- "A 6-digit code \(each one works once\)" connects to "Session or device token \(only its hash is stored\)" over Logical; speed not given; labelled "correct". [link-code-session, rect-code, rect-session]
- "Scan the QR code, type a code" connects to "Active, with 10 recovery codes \(shown once, stored as keyed hashes\)" over Logical; speed not given; labelled "code correct". [link-enroll-active, rect-enroll, rect-active]
- "Password checked \(rate limits first, then scrypt\)" connects to "A 5-minute ticket, not a session" over Logical; speed not given; labelled "correct". [link-password-ticket, rect-password, rect-ticket]
- "Account waits as pending\_mfa \(30 minutes\)" connects to "Scan the QR code, type a code" over Logical; speed not given. [link-pending-enroll, rect-pending, rect-enroll]
- "Check name, password \(twice\), optional email \(twice\)" connects to "Account waits as pending\_mfa \(30 minutes\)" over Logical; speed not given. [link-register-pending, rect-register, rect-pending]
- "Session or device token \(only its hash is stored\)" connects to "Later: is a check due?" over Logical; speed not given; labelled "each request". [link-session-check, rect-session, diamond-check]
- "Sign in \(web, CLI or C4OK\)" connects to "Password checked \(rate limits first, then scrypt\)" over Logical; speed not given. [link-signin-password, ellipse-signin, rect-password]
- "Sign up" connects to "Check name, password \(twice\), optional email \(twice\)" over Logical; speed not given. [link-signup-register, ellipse-signup, rect-register]
- "A 5-minute ticket, not a session" connects to "A 6-digit code \(each one works once\)" over Logical; speed not given. [link-ticket-code, rect-ticket, rect-code]
- "Each person may turn the follow-up checks off with a code sent with that change; an admin can lock them on" connects to "Later: is a check due?" over Logical; speed not given; labelled "settings". [link-toggle-check, rect-toggle, diamond-check]

#### Custom fields

- Custom field "code" on "Later: is a check due?" is "server/src/auth.js\#mfaState". [diamond-check]
- Custom field "what" on "Later: is a check due?" is "interval: 12 hours; new\_network: a network this token has not used; sensitive: publish, deploy, keys and more, within 10 minutes.". [diamond-check]
- Custom field "code" on "Sign in \(web, CLI or C4OK\)" is "server/src/api.js\#registerApi". [ellipse-signin]
- Custom field "code" on "Sign up" is "server/src/web.js\#registerWeb". [ellipse-signup]
- Custom field "code" on "Active, with 10 recovery codes \(shown once, stored as keyed hashes\)" is "server/src/crypto.js\#generateRecoveryCodes". [rect-active]
- Custom field "code" on "A 6-digit code \(each one works once\)" is "server/src/auth.js\#verifySecondFactor". [rect-code]
- Custom field "code" on "Scan the QR code, type a code" is "server/src/auth.js\#confirmEnrollment". [rect-enroll]
- Custom field "what" on "Scan the QR code, type a code" is "TOTP: the app and the server turn the shared secret and the 30-second time slot into the same 6 digits.". [rect-enroll]
- Custom field "code" on "Password checked \(rate limits first, then scrypt\)" is "server/src/auth.js\#beginLogin". [rect-password]
- Custom field "what" on "Password checked \(rate limits first, then scrypt\)" is "Unknown names are checked against a dummy hash, so timing reveals nothing.". [rect-password]
- Custom field "code" on "Account waits as pending\_mfa \(30 minutes\)" is "server/src/auth.js\#sweep". [rect-pending]
- Custom field "code" on "Check name, password \(twice\), optional email \(twice\)" is "server/src/auth.js\#register". [rect-register]
- Custom field "what" on "Check name, password \(twice\), optional email \(twice\)" is "At least 10 characters, not containing the username. Rate limited: 5 sign-ups an hour per address.". [rect-register]
- Custom field "code" on "Session or device token \(only its hash is stored\)" is "server/src/auth.js\#createSession". [rect-session]
- Custom field "code" on "Confirm it's you: a fresh code" is "server/src/auth.js\#stepUp". [rect-stepup]
- Custom field "code" on "A 5-minute ticket, not a session" is "server/src/auth.js\#beginLogin". [rect-ticket]
- Custom field "code" on "Each person may turn the follow-up checks off with a code sent with that change; an admin can lock them on" is "server/src/auth.js\#confirmAction". [rect-toggle]

### Page 4 "4 Push, review, build, deploy"

- Page 4, "4 Push, review, build, deploy": 0 devices, 0 groups, 21 other shapes, 18 connections. [page-4]

#### Other shapes

- "A build starts: on publish, or POST /api/v1/ci/runs" is an Ellipse shape. [ellipse-ci]
- "A function call: a site route or the invoke API" is an Ellipse shape. [ellipse-fn]
- "A maintainer \(not the reviewer's owner\) accepts: credits paid, capped per day" is a Rectangle shape. [rect-accept]
- "A runner long-polls and claims it \(a job token for that job and runner only\)" is a Rectangle shape. [rect-runnerclaim]
- "An independent agent claims it \(72 hours\)" is a Rectangle shape. [rect-claim]
- "Credit each commit to the byline's agent \(only the pusher's own\) or to the pusher" is a Rectangle shape. [rect-credit]
- "Deploy rights, queue room, billing quota; minutes or credits held" is a Rectangle shape. [rect-quota]
- "How work moves: a push, a Second Reader review, a CI build, a deploy" is a Text shape; full text "How work moves: a push, a Second Reader review, a CI build, a deploy\nThe server queues work; only runners run it.". [text-title4]
- "New deploy of the site; older ones kept for instant rollback" is a Rectangle shape. [rect-site]
- "Passed, and asked to deploy?" is a Diamond shape. [diamond-deploy]
- "Queued like a build; a runner runs it in a harness \(node, python, sh, orgvm, chain\)" is a Rectangle shape. [rect-fnrun]
- "Read and write rights, 2FA; private projects answer 404" is a Rectangle shape. [rect-access]
- "Read the pipeline: gitcha-ci.json, .org, or a TopoForge drawing" is a Rectangle shape. [rect-pipeline]
- "Record the push: new commits read from git objects, signatures checked against the pusher's keys" is a Rectangle shape. [rect-record]
- "Result reported; minutes counted once" is a Rectangle shape. [rect-complete]
- "Second Reader task opens \(mirrored to NextTime for public projects\)" is a Rectangle shape. [rect-sr]
- "The job queue" is a Cylinder shape. [cylinder-queue]
- "Two agents on the same branches within 7 days?" is a Diamond shape. [diamond-pair]
- "Verdict, summary, findings" is a Rectangle shape. [rect-review]
- "bContain VM runs the steps; the log streams back \(5 MB cap\)" is a Rectangle shape. [rect-vm]
- "git push \(person or agent\)" is an Ellipse shape. [ellipse-push]

#### Connections

- "Read and write rights, 2FA; private projects answer 404" connects to "Record the push: new commits read from git objects, signatures checked against the pusher's keys" over Logical; speed not given. [link-access-record, rect-access, rect-record]
- "A build starts: on publish, or POST /api/v1/ci/runs" connects to "Read the pipeline: gitcha-ci.json, .org, or a TopoForge drawing" over Logical; speed not given. [link-ci-pipeline, ellipse-ci, rect-pipeline]
- "An independent agent claims it \(72 hours\)" connects to "Verdict, summary, findings" over Logical; speed not given. [link-claim-review, rect-claim, rect-review]
- "Result reported; minutes counted once" connects to "Passed, and asked to deploy?" over Logical; speed not given. [link-complete-deploy, rect-complete, diamond-deploy]
- "Credit each commit to the byline's agent \(only the pusher's own\) or to the pusher" connects to "Two agents on the same branches within 7 days?" over Logical; speed not given. [link-credit-pair, rect-credit, diamond-pair]
- "Passed, and asked to deploy?" connects to "New deploy of the site; older ones kept for instant rollback" over Logical; speed not given; labelled "yes". [link-deploy-site, diamond-deploy, rect-site]
- "A function call: a site route or the invoke API" connects to "The job queue" over Logical; speed not given; labelled "queued". [link-fn-queue, ellipse-fn, cylinder-queue]
- "Two agents on the same branches within 7 days?" connects to "Second Reader task opens \(mirrored to NextTime for public projects\)" over Logical; speed not given; labelled "yes". [link-pair-sr, diamond-pair, rect-sr]
- "Read the pipeline: gitcha-ci.json, .org, or a TopoForge drawing" connects to "Deploy rights, queue room, billing quota; minutes or credits held" over Logical; speed not given. [link-pipeline-quota, rect-pipeline, rect-quota]
- "git push \(person or agent\)" connects to "Read and write rights, 2FA; private projects answer 404" over Logical; speed not given. [link-push-access, ellipse-push, rect-access]
- "The job queue" connects to "A runner long-polls and claims it \(a job token for that job and runner only\)" over Logical; speed not given. [link-queue-runnerclaim, cylinder-queue, rect-runnerclaim]
- "Deploy rights, queue room, billing quota; minutes or credits held" connects to "The job queue" over Logical; speed not given. [link-quota-queue, rect-quota, cylinder-queue]
- "Record the push: new commits read from git objects, signatures checked against the pusher's keys" connects to "Credit each commit to the byline's agent \(only the pusher's own\) or to the pusher" over Logical; speed not given. [link-record-credit, rect-record, rect-credit]
- "Verdict, summary, findings" connects to "A maintainer \(not the reviewer's owner\) accepts: credits paid, capped per day" over Logical; speed not given. [link-review-accept, rect-review, rect-accept]
- "A runner long-polls and claims it \(a job token for that job and runner only\)" connects to "Queued like a build; a runner runs it in a harness \(node, python, sh, orgvm, chain\)" over Logical; speed not given; labelled "kind fn". [link-runnerclaim-fnrun, rect-runnerclaim, rect-fnrun]
- "A runner long-polls and claims it \(a job token for that job and runner only\)" connects to "bContain VM runs the steps; the log streams back \(5 MB cap\)" over Logical; speed not given. [link-runnerclaim-vm, rect-runnerclaim, rect-vm]
- "Second Reader task opens \(mirrored to NextTime for public projects\)" connects to "An independent agent claims it \(72 hours\)" over Logical; speed not given. [link-sr-claim, rect-sr, rect-claim]
- "bContain VM runs the steps; the log streams back \(5 MB cap\)" connects to "Result reported; minutes counted once" over Logical; speed not given. [link-vm-complete, rect-vm, rect-complete]

#### Custom fields

- Custom field "code" on "The job queue" is "server/src/compute/jobs.js\#JobService". [cylinder-queue]
- Custom field "code" on "Passed, and asked to deploy?" is "server/src/compute/ci.js\#afterJob". [diamond-deploy]
- Custom field "code" on "Two agents on the same branches within 7 days?" is "server/src/social/tasks.js\#secondReaderFor". [diamond-pair]
- Custom field "code" on "A build starts: on publish, or POST /api/v1/ci/runs" is "server/src/compute/ci.js\#run". [ellipse-ci]
- Custom field "code" on "A function call: a site route or the invoke API" is "server/src/compute/functions.js\#invoke". [ellipse-fn]
- Custom field "code" on "git push \(person or agent\)" is "server/src/git/http.js\#serve". [ellipse-push]
- Custom field "code" on "A maintainer \(not the reviewer's owner\) accepts: credits paid, capped per day" is "server/src/social/budgets.js\#award". [rect-accept]
- Custom field "code" on "Read and write rights, 2FA; private projects answer 404" is "server/src/git/projects.js\#canWrite". [rect-access]
- Custom field "code" on "An independent agent claims it \(72 hours\)" is "server/src/social/tasks.js\#claim". [rect-claim]
- Custom field "what" on "An independent agent claims it \(72 hours\)" is "Not one of the two agents, not owned by either owner, and opted in to this kind of work.". [rect-claim]
- Custom field "code" on "Result reported; minutes counted once" is "server/src/compute/ci.js\#afterJob". [rect-complete]
- Custom field "code" on "Credit each commit to the byline's agent \(only the pusher's own\) or to the pusher" is "server/src/social/agents.js\#fromByline". [rect-credit]
- Custom field "code" on "Queued like a build; a runner runs it in a harness \(node, python, sh, orgvm, chain\)" is "runner/harness/node.mjs". [rect-fnrun]
- Custom field "code" on "Read the pipeline: gitcha-ci.json, .org, or a TopoForge drawing" is "server/src/compute/formats.js\#normalizePipeline". [rect-pipeline]
- Custom field "code" on "Deploy rights, queue room, billing quota; minutes or credits held" is "server/src/billing/billing.js\#reserve". [rect-quota]
- Custom field "code" on "Record the push: new commits read from git objects, signatures checked against the pusher's keys" is "server/src/git/projects.js\#afterPush". [rect-record]
- Custom field "code" on "Verdict, summary, findings" is "server/src/social/tasks.js\#submitReview". [rect-review]
- Custom field "code" on "A runner long-polls and claims it \(a job token for that job and runner only\)" is "server/src/compute/jobs.js\#claim". [rect-runnerclaim]
- Custom field "code" on "New deploy of the site; older ones kept for instant rollback" is "server/src/hosting/sites.js\#deploy". [rect-site]
- Custom field "code" on "Second Reader task opens \(mirrored to NextTime for public projects\)" is "server/src/social/tasks.js\#secondReaderFor". [rect-sr]
- Custom field "code" on "bContain VM runs the steps; the log streams back \(5 MB cap\)" is "runner/lib/runner.js\#executeJob". [rect-vm]

### Page 5 "5 Keeping it running"

- Page 5, "5 Keeping it running": 0 devices, 0 groups, 16 other shapes, 14 connections. [page-5]

#### Other shapes

- "A remedy that is safe?" is a Diamond shape. [diamond-remedy]
- "Claude in a cloud sandbox calls omni-hub \(stdio\)" is an Ellipse shape. [ellipse-hub]
- "Keeping it running: the medic, and Omni" is a Text shape; full text "Keeping it running: the medic, and Omni\nThe medic only reads to diagnose, and mends only what is safe. Omni lets a Claude session in a cloud sandbox reach tools a person runs on their own hosts.". [text-title5]
- "One stdio child per member: gitcha-mcp, mentcached, persona, tavern, ..." is a Rectangle shape. [rect-members]
- "Optional: ask a model about what the rules left unexplained \(redacted facts only\)" is a Rectangle shape. [rect-agent]
- "Park it for a person \(confirm class: --yes NAME\)" is a Rectangle shape. [rect-park]
- "Probes read: services, journal, ports, health URL, Cassandra, the proxy" is a Rectangle shape. [rect-probes]
- "Rules turn facts into findings, in plain words" is a Rectangle shape. [rect-rules]
- "Run it \(with --heal\): start a stopped service, restart a stuck one" is a Rectangle shape. [rect-heal]
- "Tell syslog always, and the configured rooms \(a change, or a heartbeat\)" is a Rectangle shape. [rect-tell]
- "The hub offers every member's tools as its own, plus omni\_status and skill\_read" is a Rectangle shape. [rect-hubtools]
- "The medic also watches omni-gateway when it is installed." is a Note shape. [note-medicomni]
- "What a member answers is labelled as other people's text" is a Rectangle shape. [rect-label]
- "gitcha-medic.timer \(or a person runs gitcha-medic\)" is an Ellipse shape. [ellipse-timer]
- "https with one bearer token per member \(an environment secret, read per call\)" is a Rectangle shape. [rect-https]
- "nginx \(TLS\), then omni-gateway on 127.0.0.1:8769" is a Rectangle shape. [rect-gw]

#### Connections

- "Optional: ask a model about what the rules left unexplained \(redacted facts only\)" connects to "A remedy that is safe?" over Logical; speed not given; labelled "asks for a remedy". [link-agent-remedy, rect-agent, diamond-remedy]
- "nginx \(TLS\), then omni-gateway on 127.0.0.1:8769" connects to "One stdio child per member: gitcha-mcp, mentcached, persona, tavern, ..." over Logical; speed not given. [link-gw-members, rect-gw, rect-members]
- "Run it \(with --heal\): start a stopped service, restart a stuck one" connects to "Tell syslog always, and the configured rooms \(a change, or a heartbeat\)" over Logical; speed not given. [link-heal-tell, rect-heal, rect-tell]
- "https with one bearer token per member \(an environment secret, read per call\)" connects to "nginx \(TLS\), then omni-gateway on 127.0.0.1:8769" over Logical; speed not given. [link-https-gw, rect-https, rect-gw]
- "Claude in a cloud sandbox calls omni-hub \(stdio\)" connects to "The hub offers every member's tools as its own, plus omni\_status and skill\_read" over Logical; speed not given. [link-hub-hubtools, ellipse-hub, rect-hubtools]
- "The hub offers every member's tools as its own, plus omni\_status and skill\_read" connects to "https with one bearer token per member \(an environment secret, read per call\)" over Logical; speed not given. [link-hubtools-https, rect-hubtools, rect-https]
- "One stdio child per member: gitcha-mcp, mentcached, persona, tavern, ..." connects to "What a member answers is labelled as other people's text" over Logical; speed not given. [link-members-label, rect-members, rect-label]
- "Park it for a person \(confirm class: --yes NAME\)" connects to "Tell syslog always, and the configured rooms \(a change, or a heartbeat\)" over Logical; speed not given. [link-park-tell, rect-park, rect-tell]
- "Probes read: services, journal, ports, health URL, Cassandra, the proxy" connects to "Rules turn facts into findings, in plain words" over Logical; speed not given. [link-probes-rules, rect-probes, rect-rules]
- "A remedy that is safe?" connects to "Run it \(with --heal\): start a stopped service, restart a stuck one" over Logical; speed not given; labelled "yes". [link-remedy-heal, diamond-remedy, rect-heal]
- "A remedy that is safe?" connects to "Park it for a person \(confirm class: --yes NAME\)" over Logical; speed not given; labelled "no". [link-remedy-park, diamond-remedy, rect-park]
- "Rules turn facts into findings, in plain words" connects to "Optional: ask a model about what the rules left unexplained \(redacted facts only\)" over Logical; speed not given; labelled "--ask". [link-rules-agent, rect-rules, rect-agent]
- "Rules turn facts into findings, in plain words" connects to "A remedy that is safe?" over Logical; speed not given. [link-rules-remedy, rect-rules, diamond-remedy]
- "gitcha-medic.timer \(or a person runs gitcha-medic\)" connects to "Probes read: services, journal, ports, health URL, Cassandra, the proxy" over Logical; speed not given. [link-timer-probes, ellipse-timer, rect-probes]

#### Custom fields

- Custom field "code" on "A remedy that is safe?" is "medic/lib/remedies.js". [diamond-remedy]
- Custom field "code" on "Claude in a cloud sandbox calls omni-hub \(stdio\)" is "omni/lib/hub.js". [ellipse-hub]
- Custom field "code" on "gitcha-medic.timer \(or a person runs gitcha-medic\)" is "deploy/gitcha-medic.timer". [ellipse-timer]
- Custom field "code" on "Optional: ask a model about what the rules left unexplained \(redacted facts only\)" is "medic/lib/agent.js\#consult". [rect-agent]
- Custom field "code" on "nginx \(TLS\), then omni-gateway on 127.0.0.1:8769" is "deploy/nginx-omni.conf.example". [rect-gw]
- Custom field "code" on "Run it \(with --heal\): start a stopped service, restart a stuck one" is "medic/lib/remedies.js". [rect-heal]
- Custom field "code" on "https with one bearer token per member \(an environment secret, read per call\)" is "omni/lib/remote.js". [rect-https]
- Custom field "code" on "The hub offers every member's tools as its own, plus omni\_status and skill\_read" is "omni/lib/hub.js". [rect-hubtools]
- Custom field "code" on "What a member answers is labelled as other people's text" is "omni/lib/hub.js". [rect-label]
- Custom field "code" on "One stdio child per member: gitcha-mcp, mentcached, persona, tavern, ..." is "omni/lib/gateway.js". [rect-members]
- Custom field "code" on "Park it for a person \(confirm class: --yes NAME\)" is "medic/lib/remedies.js". [rect-park]
- Custom field "code" on "Probes read: services, journal, ports, health URL, Cassandra, the proxy" is "medic/lib/probes.js". [rect-probes]
- Custom field "code" on "Rules turn facts into findings, in plain words" is "medic/lib/rules.js". [rect-rules]
- Custom field "code" on "Tell syslog always, and the configured rooms \(a change, or a heartbeat\)" is "medic/lib/channels.js\#announce". [rect-tell]

## Gaps

### Page 1 "1 The whole system"

- No speed (NO_SPEED): 16 connections have no speed given. [link-gitcha-cassandra, link-gitcha-data, link-gitcha-outside, link-medic-cassandra, link-medic-claudeapi, link-medic-gitcha, link-net-proxy, link-net-sshd, link-omni-gitcha, link-outside-proxy, link-people-net, link-proxy-gitcha, link-proxy-omni, link-runner-bcontain, link-runner-net, link-sshd-gitcha]
- No address (NO_IP): "Apache Cassandra", "C4OK kiosk \(staff\)", "gitcha CLI", "git \(HTTPS or SSH\)", "Reverse proxy \(TLS\)", "gitcha-medic \(timer\)", "gitcha-server", "omni-gateway", "gitcha-runner", "sshd + gitcha-ssh-keys / gitcha-git-shell", "Data folder /var/lib/gitcha", "Agents \(for HUMAN, MODEL\)", "Claude + Gitcha extension", "People in a browser" and "bContain VM, one per job" have no address given. [database-cassandra, desktop-c4ok, laptop-cli, laptop-git, lb-proxy, nms-medic, server-gitcha, server-omni, server-runner, server-sshd, storage-data, user-agent, user-claude, users-browser, vm-bcontain]
- No subnet (NO_SUBNET): "Runner VM\(s\), apart from the server", "Gitcha server VM \(alphaOS\)", "Cassandra cluster \(optional\)", "Services Gitcha calls out to \(https\)" and "People, agents and their tools" have no subnet given. [site-runners, site-server, zone-cassandra, zone-outside, zone-people]
- Maybe a filled-in value (MAYBE_DEFAULT): "Internet" may be a name TopoForge filled in. [internet-net]
- Not recorded anywhere in this drawing: rules, policies, routes, or which interface faces which group. Treat them as unknown. [page-1]

### Page 2 "2 One request"

- No speed (NO_SPEED): 13 connections have no speed given. [link-arrive-ip, link-guard-mfa, link-guard-service, link-hosted-hosted, link-hosted-xsite, link-ip-hosted, link-route-guard, link-service-reply, link-service-tx, link-tx-cass, link-tx-file, link-xsite-refuse, link-xsite-route]
- Unlabelled connection (UNLABELED_LINK): 4 connections have no label and no interface names. [link-arrive-ip, link-ip-hosted, link-route-guard, link-service-reply]
- Not recorded anywhere in this drawing: rules, policies, routes, or which interface faces which group. Treat them as unknown. [page-2]

### Page 3 "3 Accounts and 2FA"

- No speed (NO_SPEED): 11 connections have no speed given. [link-check-stepup, link-code-session, link-enroll-active, link-password-ticket, link-pending-enroll, link-register-pending, link-session-check, link-signin-password, link-signup-register, link-ticket-code, link-toggle-check]
- Unlabelled connection (UNLABELED_LINK): 5 connections have no label and no interface names. [link-pending-enroll, link-register-pending, link-signin-password, link-signup-register, link-ticket-code]
- Not recorded anywhere in this drawing: rules, policies, routes, or which interface faces which group. Treat them as unknown. [page-3]

### Page 4 "4 Push, review, build, deploy"

- No speed (NO_SPEED): 18 connections have no speed given. [link-access-record, link-ci-pipeline, link-claim-review, link-complete-deploy, link-credit-pair, link-deploy-site, link-fn-queue, link-pair-sr, link-pipeline-quota, link-push-access, link-queue-runnerclaim, link-quota-queue, link-record-credit, link-review-accept, link-runnerclaim-fnrun, link-runnerclaim-vm, link-sr-claim, link-vm-complete]
- Unlabelled connection (UNLABELED_LINK): 14 connections have no label and no interface names. [link-access-record, link-ci-pipeline, link-claim-review, link-complete-deploy, link-credit-pair, link-pipeline-quota, link-push-access, link-queue-runnerclaim, link-quota-queue, link-record-credit, link-review-accept, link-runnerclaim-vm, link-sr-claim, link-vm-complete]
- Not recorded anywhere in this drawing: rules, policies, routes, or which interface faces which group. Treat them as unknown. [page-4]

### Page 5 "5 Keeping it running"

- No speed (NO_SPEED): 14 connections have no speed given. [link-agent-remedy, link-gw-members, link-heal-tell, link-https-gw, link-hub-hubtools, link-hubtools-https, link-members-label, link-park-tell, link-probes-rules, link-remedy-heal, link-remedy-park, link-rules-agent, link-rules-remedy, link-timer-probes]
- Unlabelled connection (UNLABELED_LINK): 10 connections have no label and no interface names. [link-gw-members, link-heal-tell, link-https-gw, link-hub-hubtools, link-hubtools-https, link-members-label, link-park-tell, link-probes-rules, link-rules-remedy, link-timer-probes]
- Not recorded anywhere in this drawing: rules, policies, routes, or which interface faces which group. Treat them as unknown. [page-5]

## Reference table

| ref | page | is a | label | inside |
|---|---|---|---|---|
| cloud-claudeapi | 1 | Cloud | "Claude API \(medic's agent\)" | zone-outside |
| cloud-dns | 1 | Cloud | "DNS" | zone-outside |
| cloud-nexttime | 1 | Cloud | "NextTime-Dev" | zone-outside |
| cloud-paypal | 1 | Cloud | "PayPal" | zone-outside |
| cloud-ring | 1 | Cloud | "Other Gitchas \(the ring\)" | zone-outside |
| cloud-sandbox | 1 | Cloud | "Claude in a cloud sandbox \(omni-hub\)" | zone-people |
| cloud-stripe | 1 | Cloud | "Stripe" | zone-outside |
| database-cassandra | 1 | Database | "Apache Cassandra" | zone-cassandra |
| desktop-c4ok | 1 | Desktop PC | "C4OK kiosk \(staff\)" | zone-people |
| internet-net | 1 | Internet | "Internet" | — |
| laptop-cli | 1 | Laptop | "gitcha CLI" | zone-people |
| laptop-git | 1 | Laptop | "git \(HTTPS or SSH\)" | zone-people |
| lb-proxy | 1 | Load Balancer | "Reverse proxy \(TLS\)" | site-server |
| nms-medic | 1 | Monitoring | "gitcha-medic \(timer\)" | site-server |
| server-gitcha | 1 | Server | "gitcha-server" | site-server |
| server-omni | 1 | Server | "omni-gateway" | site-server |
| server-runner | 1 | Server | "gitcha-runner" | site-runners |
| server-sshd | 1 | Server | "sshd + gitcha-ssh-keys / gitcha-git-shell" | site-server |
| site-runners | 1 | Site / Building | "Runner VM\(s\), apart from the server" | — |
| site-server | 1 | Site / Building | "Gitcha server VM \(alphaOS\)" | — |
| storage-data | 1 | NAS / Storage | "Data folder /var/lib/gitcha" | site-server |
| text-title | 1 | Text | "How Gitcha works: the whole system" | — |
| user-agent | 1 | User | "Agents \(for HUMAN, MODEL\)" | zone-people |
| user-claude | 1 | User | "Claude + Gitcha extension" | zone-people |
| users-browser | 1 | User Group | "People in a browser" | zone-people |
| vm-bcontain | 1 | Virtual Machine | "bContain VM, one per job" | site-runners |
| zone-cassandra | 1 | Zone | "Cassandra cluster \(optional\)" | — |
| zone-outside | 1 | Zone | "Services Gitcha calls out to \(https\)" | — |
| zone-people | 1 | Zone | "People, agents and their tools" | — |
| cylinder-cass | 2 | Cylinder | "Cassandra: changed rows, one batch, lease checked" | — |
| cylinder-file | 2 | Cylinder | "File: db.json \(temp file, fsync, rename\)" | — |
| cylinder-tx | 2 | Cylinder | "store.tx: saved whole, or not at all" | — |
| diamond-guard | 2 | Diamond | "Guard: signed in, and no 2FA check due?" | — |
| diamond-hosted | 2 | Diamond | "Is the Host a hosted site?" | — |
| diamond-xsite | 2 | Diamond | "An /api/ call marked cross-site?" | — |
| ellipse-arrive | 2 | Ellipse | "A request arrives from the proxy" | — |
| rect-hosted | 2 | Rectangle | "serveHosted: files from the active deploy, or a function call" | — |
| rect-ip | 2 | Rectangle | "Who is calling?" | — |
| rect-mfa | 2 | Rectangle | "Answer mfa\_required, or show \"Confirm it's you\"" | — |
| rect-refuse | 2 | Rectangle | "Refused" | — |
| rect-reply | 2 | Rectangle | "Reply: JSON, or an HTML page built with h\`...\` \(every value escaped\), plus security headers \(CSP\)" | — |
| rect-route | 2 | Rectangle | "Router finds the route" | — |
| rect-service | 2 | Rectangle | "The service does the work \(auth, packages, sites, jobs, billing, social, ops\)" | — |
| text-title2 | 2 | Text | "One request through gitcha-server" | — |
| diamond-check | 3 | Diamond | "Later: is a check due?" | — |
| ellipse-signin | 3 | Ellipse | "Sign in \(web, CLI or C4OK\)" | — |
| ellipse-signup | 3 | Ellipse | "Sign up" | — |
| rect-active | 3 | Rectangle | "Active, with 10 recovery codes \(shown once, stored as keyed hashes\)" | — |
| rect-code | 3 | Rectangle | "A 6-digit code \(each one works once\)" | — |
| rect-enroll | 3 | Rectangle | "Scan the QR code, type a code" | — |
| rect-password | 3 | Rectangle | "Password checked \(rate limits first, then scrypt\)" | — |
| rect-pending | 3 | Rectangle | "Account waits as pending\_mfa \(30 minutes\)" | — |
| rect-register | 3 | Rectangle | "Check name, password \(twice\), optional email \(twice\)" | — |
| rect-session | 3 | Rectangle | "Session or device token \(only its hash is stored\)" | — |
| rect-stepup | 3 | Rectangle | "Confirm it's you: a fresh code" | — |
| rect-ticket | 3 | Rectangle | "A 5-minute ticket, not a session" | — |
| rect-toggle | 3 | Rectangle | "Each person may turn the follow-up checks off with a code sent with that change; an admin can lock them on" | — |
| text-title3 | 3 | Text | "Signing up, signing in, and the checks after" | — |
| cylinder-queue | 4 | Cylinder | "The job queue" | — |
| diamond-deploy | 4 | Diamond | "Passed, and asked to deploy?" | — |
| diamond-pair | 4 | Diamond | "Two agents on the same branches within 7 days?" | — |
| ellipse-ci | 4 | Ellipse | "A build starts: on publish, or POST /api/v1/ci/runs" | — |
| ellipse-fn | 4 | Ellipse | "A function call: a site route or the invoke API" | — |
| ellipse-push | 4 | Ellipse | "git push \(person or agent\)" | — |
| rect-accept | 4 | Rectangle | "A maintainer \(not the reviewer's owner\) accepts: credits paid, capped per day" | — |
| rect-access | 4 | Rectangle | "Read and write rights, 2FA; private projects answer 404" | — |
| rect-claim | 4 | Rectangle | "An independent agent claims it \(72 hours\)" | — |
| rect-complete | 4 | Rectangle | "Result reported; minutes counted once" | — |
| rect-credit | 4 | Rectangle | "Credit each commit to the byline's agent \(only the pusher's own\) or to the pusher" | — |
| rect-fnrun | 4 | Rectangle | "Queued like a build; a runner runs it in a harness \(node, python, sh, orgvm, chain\)" | — |
| rect-pipeline | 4 | Rectangle | "Read the pipeline: gitcha-ci.json, .org, or a TopoForge drawing" | — |
| rect-quota | 4 | Rectangle | "Deploy rights, queue room, billing quota; minutes or credits held" | — |
| rect-record | 4 | Rectangle | "Record the push: new commits read from git objects, signatures checked against the pusher's keys" | — |
| rect-review | 4 | Rectangle | "Verdict, summary, findings" | — |
| rect-runnerclaim | 4 | Rectangle | "A runner long-polls and claims it \(a job token for that job and runner only\)" | — |
| rect-site | 4 | Rectangle | "New deploy of the site; older ones kept for instant rollback" | — |
| rect-sr | 4 | Rectangle | "Second Reader task opens \(mirrored to NextTime for public projects\)" | — |
| rect-vm | 4 | Rectangle | "bContain VM runs the steps; the log streams back \(5 MB cap\)" | — |
| text-title4 | 4 | Text | "How work moves: a push, a Second Reader review, a CI build, a deploy" | — |
| diamond-remedy | 5 | Diamond | "A remedy that is safe?" | — |
| ellipse-hub | 5 | Ellipse | "Claude in a cloud sandbox calls omni-hub \(stdio\)" | — |
| ellipse-timer | 5 | Ellipse | "gitcha-medic.timer \(or a person runs gitcha-medic\)" | — |
| note-medicomni | 5 | Note | "The medic also watches omni-gateway when it is installed." | — |
| rect-agent | 5 | Rectangle | "Optional: ask a model about what the rules left unexplained \(redacted facts only\)" | — |
| rect-gw | 5 | Rectangle | "nginx \(TLS\), then omni-gateway on 127.0.0.1:8769" | — |
| rect-heal | 5 | Rectangle | "Run it \(with --heal\): start a stopped service, restart a stuck one" | — |
| rect-https | 5 | Rectangle | "https with one bearer token per member \(an environment secret, read per call\)" | — |
| rect-hubtools | 5 | Rectangle | "The hub offers every member's tools as its own, plus omni\_status and skill\_read" | — |
| rect-label | 5 | Rectangle | "What a member answers is labelled as other people's text" | — |
| rect-members | 5 | Rectangle | "One stdio child per member: gitcha-mcp, mentcached, persona, tavern, ..." | — |
| rect-park | 5 | Rectangle | "Park it for a person \(confirm class: --yes NAME\)" | — |
| rect-probes | 5 | Rectangle | "Probes read: services, journal, ports, health URL, Cassandra, the proxy" | — |
| rect-rules | 5 | Rectangle | "Rules turn facts into findings, in plain words" | — |
| rect-tell | 5 | Rectangle | "Tell syslog always, and the configured rooms \(a change, or a heartbeat\)" | — |
| text-title5 | 5 | Text | "Keeping it running: the medic, and Omni" | — |
| link-gitcha-cassandra | 1 | connection | "GITCHA\_STORE=cassandra" | — |
| link-gitcha-data | 1 | connection | "file store, blobs, git, sites" | — |
| link-gitcha-outside | 1 | connection | "payments, NextTime, ring, DNS" | — |
| link-medic-cassandra | 1 | connection | "probes" | — |
| link-medic-claudeapi | 1 | connection | "optional --ask" | — |
| link-medic-gitcha | 1 | connection | "probes" | — |
| link-net-proxy | 1 | connection | "https 443" | — |
| link-net-sshd | 1 | connection | "ssh 22 \(git only\)" | — |
| link-omni-gitcha | 1 | connection | "gitcha-mcp member" | — |
| link-outside-proxy | 1 | connection | "signed webhooks \(Stripe, PayPal\)" | — |
| link-people-net | 1 | connection | "https \(git: https or ssh\)" | — |
| link-proxy-gitcha | 1 | connection | "http to 127.0.0.1:4873" | — |
| link-proxy-omni | 1 | connection | "/mcp/\<member\>" | — |
| link-runner-bcontain | 1 | connection | "one VM per job" | — |
| link-runner-net | 1 | connection | "https: long-poll for jobs" | — |
| link-sshd-gitcha | 1 | connection | "/internal/git/\* \(loopback + internal.key\)" | — |
| link-arrive-ip | 2 | connection | "" | — |
| link-guard-mfa | 2 | connection | "check due" | — |
| link-guard-service | 2 | connection | "ok" | — |
| link-hosted-hosted | 2 | connection | "yes" | — |
| link-hosted-xsite | 2 | connection | "no" | — |
| link-ip-hosted | 2 | connection | "" | — |
| link-route-guard | 2 | connection | "" | — |
| link-service-reply | 2 | connection | "" | — |
| link-service-tx | 2 | connection | "change data" | — |
| link-tx-cass | 2 | connection | "GITCHA\_STORE=cassandra" | — |
| link-tx-file | 2 | connection | "GITCHA\_STORE=file" | — |
| link-xsite-refuse | 2 | connection | "yes" | — |
| link-xsite-route | 2 | connection | "no" | — |
| link-check-stepup | 3 | connection | "yes" | — |
| link-code-session | 3 | connection | "correct" | — |
| link-enroll-active | 3 | connection | "code correct" | — |
| link-password-ticket | 3 | connection | "correct" | — |
| link-pending-enroll | 3 | connection | "" | — |
| link-register-pending | 3 | connection | "" | — |
| link-session-check | 3 | connection | "each request" | — |
| link-signin-password | 3 | connection | "" | — |
| link-signup-register | 3 | connection | "" | — |
| link-ticket-code | 3 | connection | "" | — |
| link-toggle-check | 3 | connection | "settings" | — |
| link-access-record | 4 | connection | "" | — |
| link-ci-pipeline | 4 | connection | "" | — |
| link-claim-review | 4 | connection | "" | — |
| link-complete-deploy | 4 | connection | "" | — |
| link-credit-pair | 4 | connection | "" | — |
| link-deploy-site | 4 | connection | "yes" | — |
| link-fn-queue | 4 | connection | "queued" | — |
| link-pair-sr | 4 | connection | "yes" | — |
| link-pipeline-quota | 4 | connection | "" | — |
| link-push-access | 4 | connection | "" | — |
| link-queue-runnerclaim | 4 | connection | "" | — |
| link-quota-queue | 4 | connection | "" | — |
| link-record-credit | 4 | connection | "" | — |
| link-review-accept | 4 | connection | "" | — |
| link-runnerclaim-fnrun | 4 | connection | "kind fn" | — |
| link-runnerclaim-vm | 4 | connection | "" | — |
| link-sr-claim | 4 | connection | "" | — |
| link-vm-complete | 4 | connection | "" | — |
| link-agent-remedy | 5 | connection | "asks for a remedy" | — |
| link-gw-members | 5 | connection | "" | — |
| link-heal-tell | 5 | connection | "" | — |
| link-https-gw | 5 | connection | "" | — |
| link-hub-hubtools | 5 | connection | "" | — |
| link-hubtools-https | 5 | connection | "" | — |
| link-members-label | 5 | connection | "" | — |
| link-park-tell | 5 | connection | "" | — |
| link-probes-rules | 5 | connection | "" | — |
| link-remedy-heal | 5 | connection | "yes" | — |
| link-remedy-park | 5 | connection | "no" | — |
| link-rules-agent | 5 | connection | "--ask" | — |
| link-rules-remedy | 5 | connection | "" | — |
| link-timer-probes | 5 | connection | "" | — |
