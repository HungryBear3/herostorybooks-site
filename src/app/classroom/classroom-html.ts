// Information-only /classroom page, served verbatim by route.ts.
// Brief by design: three story choices, a short how-it-works, plain proposed
// privacy terms and the three approved Pasta Planet samples. Intake is closed;
// no forms, scripts, remote requests or sticky overlays.
export const CLASSROOM_HTML: string = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; img-src 'self'; font-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'">
<link rel="canonical" href="https://herostorybooks.com/classroom">
<title>A classroom keepsake · Hero Story Books</title>
<style>
:root{--paper:#FAF5EA;--paper2:#F2EADA;--card:#FFFCF5;--ink:#22392F;--forest:#2B4A3D;--deep:#1E342B;--muted:#55645B;--sage:#E2E7D3;--sage2:#C7D0B2;--olive:#5B6B3C;--gold:#D6A443;--gold2:#F0D9A4;--rose:#E6BCA9;--line:#DCD5C2;--serif:"Iowan Old Style","Palatino Linotype",Palatino,"Book Antiqua",Georgia,serif;--sans:"Avenir Next","Segoe UI",system-ui,-apple-system,Helvetica,Arial,sans-serif}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;scroll-behavior:smooth}
body{margin:0;background:var(--paper);color:var(--ink);font:17px/1.62 var(--serif);overflow-x:hidden}
h1,h2,h3,p,ol,ul,figure{margin:0}
h1,h2,h3{font-weight:400;line-height:1.08;text-wrap:balance}
p{text-wrap:pretty}
a{color:var(--forest);text-underline-offset:3px}
a:hover{color:var(--olive)}
:focus-visible{outline:3px solid var(--gold);outline-offset:3px;border-radius:3px}
.skip{position:absolute;left:12px;top:-60px;background:var(--deep);color:var(--paper);padding:10px 16px;font:600 14px/1 var(--sans);border-radius:4px;z-index:20;text-decoration:none}
.skip:focus{top:12px}
.page{container:pg/inline-size}
.notice{background:var(--sage);color:var(--deep);font:600 12.5px/1.45 var(--sans);letter-spacing:.02em;padding:8px 16px;text-align:center}
.wrap{width:min(1160px,calc(100% - 40px));margin-inline:auto}
.eyebrow{display:block;font:700 11px/1.5 var(--sans);letter-spacing:.17em;text-transform:uppercase;color:var(--muted);margin-bottom:16px}
/* header */
.hdr{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:22px 0;border-bottom:1px solid var(--line)}
.brand{font-size:22px;line-height:1.1;letter-spacing:-.02em;display:flex;align-items:center;gap:12px}
.brand b{font-weight:400}
.brand span{display:block;font:600 10px/1.4 var(--sans);letter-spacing:.22em;text-transform:uppercase;color:var(--muted);margin-top:5px}
.seal{width:38px;height:38px;flex:0 0 auto;display:block}
.nav{display:none;gap:4px 22px;font:500 13.5px/1 var(--sans)}
.nav a{text-decoration:none;color:var(--ink);padding:10px 0;border-bottom:1px solid transparent}
.nav a:hover{border-bottom-color:var(--ink);color:var(--ink)}
/* hero */
.hero{display:grid;gap:36px;padding:36px 0 48px}
h1{font-size:clamp(42px,11.4cqi,84px);letter-spacing:-.035em;line-height:1}
h1 span{display:block}
h1 em{display:block;color:var(--olive);margin-top:.06em}
.lead{font-size:clamp(18px,4.8cqi,21px);line-height:1.55;margin-top:24px;max-width:31em}
.cta{margin-top:28px;display:grid;gap:10px;max-width:460px}
.cta button{appearance:none;font:700 14.5px/1.4 var(--sans);letter-spacing:.01em;color:#263B2E;background:var(--sage);border:1.5px dashed #7C8B6E;border-radius:999px;padding:15px 16px;min-height:54px;width:100%;cursor:not-allowed;opacity:1;display:flex;align-items:center;justify-content:center;text-align:center}
.cta small{font:13px/1.6 var(--sans);color:var(--muted)}
/* hero art */
.art{position:relative;min-height:360px;border-radius:999px 999px 14px 14px;background:var(--sage);display:grid;place-items:center;padding:56px 24px 78px;overflow:hidden;isolation:isolate}
.art::before{content:"";position:absolute;inset:0;background:radial-gradient(circle at 20% 30%,rgba(255,255,255,.35) 0 1px,transparent 1.5px) 0 0/14px 14px;z-index:-1;opacity:.7}
.sun{position:absolute;width:66px;height:66px;border-radius:50%;background:var(--gold);top:14%;right:16%;z-index:-1}
.hill{position:absolute;left:-10%;right:-10%;bottom:-40px;height:120px;border-radius:50% 50% 0 0;background:var(--sage2);z-index:-1}
.book{position:relative;width:min(220px,58cqi);aspect-ratio:3/4;transform:rotate(-5deg)}
.book .pages{position:absolute;inset:6px -9px -8px 10px;background:repeating-linear-gradient(90deg,#F7F0E1 0 2px,#E7DDC8 2px 3px);border-radius:3px 6px 6px 3px;box-shadow:6px 10px 24px rgba(30,52,43,.18)}
.book .cover{position:absolute;inset:0;background:var(--forest);border-radius:3px 8px 8px 3px;box-shadow:inset 13px 0 0 #234035,inset 15px 0 0 rgba(255,255,255,.06);display:grid;align-content:center;justify-items:center;text-align:center;padding:24px 20px 24px 32px;color:var(--gold2)}
.book .cover .k{font:700 8.5px/1.4 var(--sans);letter-spacing:.22em;text-transform:uppercase}
.book .cover .t{font-size:clamp(24px,7cqi,32px);line-height:1.05;color:#FBF3E1;margin:14px 0}
.book .cover .m{width:46px;height:46px;border:1.5px solid var(--gold);border-radius:50%;position:relative}
.book .cover .m::before{content:"";position:absolute;inset:9px;border-radius:50% 50% 0 0;border:1.5px solid var(--gold);border-bottom:0}
.book .cover .m::after{content:"";position:absolute;left:50%;top:8px;width:4px;height:4px;border-radius:50%;background:var(--gold);transform:translateX(-50%)}
.ribbon{position:absolute;bottom:-34px;left:58%;width:14px;height:52px;background:var(--rose);clip-path:polygon(0 0,100% 0,100% 100%,50% 82%,0 100%)}
.art figcaption{position:absolute;left:0;right:0;bottom:18px;text-align:center;font:12px/1.5 var(--sans);color:var(--ink);padding:0 20px}
.tag{display:inline-flex;align-items:center;gap:7px;font:700 10.5px/1.3 var(--sans);letter-spacing:.12em;text-transform:uppercase;padding:6px 11px;border-radius:999px;background:var(--card);border:1px solid var(--line);color:var(--ink)}
.tag::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--gold)}
/* sections */
.sec{padding:64px 0;border-top:1px solid var(--line)}
.head{max-width:680px;margin-bottom:32px}
h2{font-size:clamp(32px,8cqi,52px);letter-spacing:-.03em}
.head p{margin-top:16px;font-size:18px}
h3{font-size:clamp(22px,5.6cqi,27px);letter-spacing:-.015em}
/* story choices */
.cards{display:grid;gap:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:24px;display:grid;gap:10px;align-content:start}
.card svg{width:64px;height:40px;display:block;margin-bottom:4px}
.card p{font-size:16px}
.together{margin-top:20px;padding:18px 22px;border-radius:12px;background:var(--forest);color:#F6EFDF;font-size:17px}
/* samples */
.samples{display:grid;gap:18px}
.slot{position:relative;display:grid;border-radius:14px;background:#13261f;border:1px solid var(--line);padding:0 0 58px;min-height:260px;overflow:hidden}
.slot img{display:block;width:100%;height:100%;min-height:260px;object-fit:cover;object-position:center}
.slot .tag{position:absolute;left:12px;right:12px;bottom:10px;justify-content:center;letter-spacing:.08em}
.slot .tag::before{background:var(--olive)}
.note{margin-top:18px;font:13.5px/1.6 var(--sans);color:var(--muted);max-width:70ch}
/* how it works */
.steps{list-style:none;padding:0;display:grid;counter-reset:s}
.step{display:grid;grid-template-columns:44px minmax(0,1fr);gap:16px;padding:20px 0;border-top:1px solid var(--line);counter-increment:s}
.step::before{content:counter(s);width:40px;height:40px;border-radius:50%;border:1.5px solid var(--forest);display:grid;place-items:center;font:700 13px/1 var(--sans);color:var(--forest);background:var(--card)}
.step p{margin-top:6px;font-size:16px;max-width:60ch}
/* privacy */
.facts{list-style:none;padding:0;display:grid;gap:14px;max-width:62ch}
.facts li{position:relative;padding-left:32px}
.facts li::before{content:"";position:absolute;left:0;top:.8em;width:20px;height:2px;background:var(--olive)}
footer{border-top:1px solid var(--line);padding:22px 0 40px;font:12.5px/1.6 var(--sans);color:var(--muted)}
/* wider layouts */
@container pg (min-width:700px){
 .wrap{width:min(1160px,calc(100% - 80px))}
 .cards{grid-template-columns:repeat(3,minmax(0,1fr))}
 .samples{grid-template-columns:1.55fr 1fr}
 .sample-primary{grid-row:span 2}
 .sample-primary img{min-height:578px}
}
@container pg (min-width:1000px){
 .nav{display:flex}
 .hero{grid-template-columns:minmax(0,1.12fr) minmax(0,.88fr);align-items:center;gap:56px;padding:56px 0 72px}
 .art{min-height:480px}
 .sec{padding:88px 0}
 .how{display:grid;grid-template-columns:minmax(0,.8fr) minmax(0,1.2fr);gap:64px;align-items:start}
}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}*{transition:none!important;animation:none!important}}
</style>
</head>
<body>
<div class="page">
<a class="skip" href="#main">Skip to content</a>
<p class="notice" role="note">Classroom book preview · Family submissions aren’t open yet</p>
<div class="wrap">
<header class="hdr">
<div class="brand"><svg class="seal" viewBox="0 0 38 38" aria-hidden="true"><circle cx="19" cy="19" r="18" fill="none" stroke="#2B4A3D" stroke-width="1.5"></circle><path d="M12 12.5h6.2c.5 0 .8.3.8.8V26c-1-.8-2-1.2-3.2-1.2H12z M26 12.5h-6.2c-.5 0-.8.3-.8.8V26c1-.8 2-1.2 3.2-1.2H26z" fill="none" stroke="#2B4A3D" stroke-width="1.4" stroke-linejoin="round"></path></svg><div><b>Hero Story Books</b><span>Classroom keepsakes</span></div></div>
<nav class="nav" aria-label="On this page"><a href="#stories">Story choices</a><a href="#book">Sample art</a><a href="#how">How it works</a><a href="#privacy">Privacy</a></nav>
</header>
<main id="main">
<section class="hero" aria-labelledby="hero-title">
<div>
<span class="eyebrow">For the class they’ll always remember</span>
<h1 id="hero-title"><span>One classroom.</span><span>One book.</span><em>Every child belongs in the story.</em></h1>
<p class="lead">Turn the friendships, discoveries and little moments of a school year into an illustrated book your class can keep.</p>
<div class="cta"><button type="button" disabled>Family submissions not open yet</button><small>Please don’t send children’s photos or personal details.</small></div>
</div>
<figure class="art" role="img" aria-label="Abstract book shape on a sage arch. Illustrative layout only, not a real book or illustration sample.">
<span class="sun" aria-hidden="true"></span><span class="hill" aria-hidden="true"></span>
<div class="book" aria-hidden="true"><div class="pages"></div><div class="cover"><span class="k">A classroom keepsake</span><span class="t">Our story together</span><span class="m"></span></div><span class="ribbon"></span></div>
<figcaption>Concept layout only — not a book or illustration sample</figcaption>
</figure>
</section>

<section class="sec" id="stories" aria-labelledby="stories-h">
<div class="head"><span class="eyebrow">Story choices</span><h2 id="stories-h">What kind of book feels like you?</h2></div>
<div class="cards">
<article class="card">
<svg viewBox="0 0 64 40" aria-hidden="true"><path d="M4 32 C18 32 18 10 32 10 S46 30 60 8" fill="none" stroke="#5B6B3C" stroke-width="2"></path><circle cx="4" cy="32" r="3.5" fill="#5B6B3C"></circle><circle cx="60" cy="8" r="5" fill="#D6A443"></circle></svg>
<h3>One big adventure</h3><p>The whole class teams up to solve one problem together. Every idea helps the story move forward.</p></article>
<article class="card">
<svg viewBox="0 0 64 40" aria-hidden="true"><circle cx="10" cy="20" r="6" fill="#C7D0B2"></circle><circle cx="25" cy="20" r="6" fill="#E6BCA9"></circle><circle cx="40" cy="20" r="6" fill="#F0D9A4"></circle><circle cx="55" cy="20" r="6" fill="#5B6B3C"></circle><path d="M4 33 H60" stroke="#2B4A3D" stroke-width="1.5"></path></svg>
<h3>Our year in class</h3><p>Favorite memories and class traditions become a story of your year together.</p></article>
<article class="card">
<svg viewBox="0 0 64 40" aria-hidden="true"><path d="M4 6 L50 20 M4 20 L50 20 M4 34 L50 20" fill="none" stroke="#2B4A3D" stroke-width="1.5"></path><circle cx="4" cy="6" r="3" fill="#5B6B3C"></circle><circle cx="4" cy="20" r="3" fill="#E6BCA9"></circle><circle cx="4" cy="34" r="3" fill="#C7D0B2"></circle><circle cx="54" cy="20" r="6" fill="#D6A443"></circle></svg>
<h3>Little stories, one book</h3><p>Small groups each have a little adventure of their own. Then all the stories come together in one ending.</p></article>
</div>
<p class="together">Whichever story you choose, each child gets a meaningful part, and teachers can appear as familiar guides with their permission.</p>
</section>

<section class="sec" id="book" aria-labelledby="book-h">
<div class="head"><span class="eyebrow">Made for the bookshelf</span><h2 id="book-h">A story to hold.</h2><p>The examples below show approved illustration samples from a different Hero Story Books title—not a finished classroom book or a promise of its final art.</p></div>
<div class="samples">
<figure class="slot sample sample-primary">
<img src="/classroom/assets/pasta-planet-page-19-art-only.png" alt="Illustration sample from Pasta Planet: a child exploring a colorful imagined planet landscape.">
<figcaption class="tag">Digital sample — illustrative only</figcaption>
</figure>
<figure class="slot sample">
<img src="/classroom/assets/pasta-planet-page-20-art-only.png" alt="Illustration sample from Pasta Planet: a child in a playful outer-space scene.">
<figcaption class="tag">Digital sample — illustrative only</figcaption>
</figure>
<figure class="slot sample">
<img src="/classroom/assets/pasta-planet-page-24-art-only.png" alt="Illustration sample from Pasta Planet: a bright storybook scene with a child and fantastical surroundings.">
<figcaption class="tag">Digital sample — illustrative only</figcaption>
</figure>
</div>
<p class="note">These three art-only images are approved examples from <em>Pasta Planet</em>. They illustrate a general visual standard only; they do not depict this classroom, an actual classroom book or a current deliverable. Binding, dimensions, page count, illustration approach and available print options are still to be confirmed.</p>
</section>

<section class="sec" id="how" aria-labelledby="how-h">
<div class="how">
<div class="head"><span class="eyebrow">Simple steps</span><h2 id="how-h">How it works</h2></div>
<ol class="steps">
<li class="step"><div><h3>Choose a story direction</h3><p>Pick the story choice that fits your class.</p></div></li>
<li class="step"><div><h3>Families share details privately</h3><p>Only once a project opens, each family privately shares approved details about their own child. Nothing is collected now.</p></div></li>
<li class="step"><div><h3>Review the proof</h3><p>The proof is reviewed and approved first. Printing is a separate release that happens only after that approval.</p></div></li>
</ol>
</div>
</section>

<section class="sec" id="privacy" aria-labelledby="privacy-h">
<div class="head"><span class="eyebrow">Proposed terms</span><h2 id="privacy-h">Privacy, plainly.</h2></div>
<ul class="facts">
<li>Raw photos and submission fields stay private to the authorized Hero Story Books team.</li>
<li>The finished book is shared with agreed recipients and can include approved names and illustrated likenesses.</li>
<li>There is no public gallery and no school endorsement; this is an independent keepsake idea.</li>
<li>All terms on this page are proposed. Family submissions are closed for now.</li>
</ul>
</section>
</main>

<footer>Hero Story Books · Classroom keepsakes · Preview only</footer>
</div>
</div>
</body>
</html>
`;
