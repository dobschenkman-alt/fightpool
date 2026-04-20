const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const Datastore = require('nedb-promises');

const app = express();
app.use(express.static('public'));
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});
if (!fs.existsSync('./db')) fs.mkdirSync('./db');

const db = {
  users:  Datastore.create({ filename: './db/users.db',  autoload: true }),
  events: Datastore.create({ filename: './db/events.db', autoload: true }),
  fights: Datastore.create({ filename: './db/fights.db', autoload: true }),
  picks:  Datastore.create({ filename: './db/picks.db',  autoload: true }),
  units:  Datastore.create({ filename: './db/units.db',  autoload: true }),
};

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({ secret: 'fightpool-2026-secret', resave: false, saveUninitialized: false, cookie: { maxAge: 7*24*60*60*1000 } }));

const requireAuth  = (req,res,next) => req.session.userId  ? next() : res.status(401).json({error:'Not logged in'});
const requireAdmin = (req,res,next) => req.session.isAdmin ? next() : res.status(403).json({error:'Admin only'});

async function seedAdmin() {
  if (!await db.users.findOne({username:'admin'})) {
    await db.users.insert({username:'admin',password:await bcrypt.hash('admin123',10),isAdmin:true,createdAt:new Date()});
    console.log('Admin created → admin / admin123');
  }
}

async function seedDatabase() {
  if ((await db.fights.find({})).length > 0) { console.log('DB already seeded.'); return; }
  console.log('Seeding...');
  const SEED = require('./seedData');
  const eventMap = {};
  for (const ev of SEED.events) {
    const doc = await db.events.insert({name:ev.name,date:ev.date,createdAt:new Date()});
    eventMap[ev.name] = doc._id;
  }
  const fightMap = {};
  for (const f of SEED.fights) {
    const doc = await db.fights.insert({eventId:eventMap[f.event],fighterA:f.fighterA,fighterB:f.fighterB,oddsA:f.oddsA,oddsB:f.oddsB,card:f.card,isMain:f.card==='Main',result:f.winner||null,createdAt:new Date()});
    fightMap[`${f.event}|${f.fighterA} vs ${f.fighterB}`] = doc._id;
  }
  for (const p of ['dob','oodie','tony','meej'])
    if (!await db.users.findOne({username:p}))
      await db.users.insert({username:p,password:await bcrypt.hash('changeme',10),isAdmin:false,createdAt:new Date()});
  for (const p of SEED.picks) {
    const fid = fightMap[`${p.event}|${p.fight}`];
    if (fid) await db.picks.insert({fightId:fid,username:p.picker,pick:p.pick,createdAt:new Date()});
  }
  for (const u of SEED.units) {
    const fid = fightMap[`${u.event}|${u.fight}`];
    if (fid) await db.units.insert({fightId:fid,username:u.picker,profit:u.profit,isMain:u.isMain,seeded:true,createdAt:new Date()});
  }
  console.log(`Seeded: ${SEED.events.length} events, ${SEED.fights.length} fights, ${SEED.picks.length} picks, ${SEED.units.length} units`);
}

// AUTH
app.get('/api/me',(req,res)=>res.json(req.session.userId?{loggedIn:true,username:req.session.username,isAdmin:!!req.session.isAdmin}:{loggedIn:false}));

app.post('/api/login',async(req,res)=>{
  try {
    const {username,password}=req.body;
    const u=await db.users.findOne({username:username.toLowerCase().trim()});
    if(!u||!await bcrypt.compare(password,u.password)) return res.status(401).json({error:'Invalid username or password'});
    req.session.userId=u._id; req.session.username=u.username; req.session.isAdmin=!!u.isAdmin;
    res.json({username:u.username,isAdmin:!!u.isAdmin});
  } catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/register',async(req,res)=>{
  try {
    const {username,password}=req.body;
    if(!username||!password||password.length<4) return res.status(400).json({error:'Username and password (min 4 chars) required'});
    const uname=username.toLowerCase().trim();
    if(await db.users.findOne({username:uname})) return res.status(409).json({error:'Username already taken'});
    const u=await db.users.insert({username:uname,password:await bcrypt.hash(password,10),isAdmin:false,createdAt:new Date()});
    req.session.userId=u._id; req.session.username=u.username; req.session.isAdmin=false;
    res.json({username:u.username,isAdmin:false});
  } catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/logout',(req,res)=>{req.session.destroy();res.json({ok:true});});

// EVENTS
app.get('/api/events',async(_,res)=>{
  try{res.json(await db.events.find({}).sort({date:1}));}catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/events',requireAdmin,async(req,res)=>{
  try{
    const {name,date}=req.body;
    if(!name||!name.trim()) return res.status(400).json({error:'Event name is required'});
    res.json(await db.events.insert({name:name.trim(),date:date||'',createdAt:new Date()}));
  }catch(e){res.status(500).json({error:e.message});}
});
app.put('/api/events/:id',requireAdmin,async(req,res)=>{
  try{const{name,date}=req.body;await db.events.update({_id:req.params.id},{$set:{name,date}});res.json({ok:true});}catch(e){res.status(500).json({error:e.message});}
});
app.delete('/api/events/:id',requireAdmin,async(req,res)=>{
  try{
    const fights=await db.fights.find({eventId:req.params.id});
    for(const f of fights){await db.picks.remove({fightId:f._id},{multi:true});await db.units.remove({fightId:f._id},{multi:true});}
    await db.fights.remove({eventId:req.params.id},{multi:true});
    await db.events.remove({_id:req.params.id});
    res.json({ok:true});
  }catch(e){res.status(500).json({error:e.message});}
});

// FIGHTS
app.get('/api/events/:eid/fights',async(req,res)=>{
  try{
    const fights=await db.fights.find({eventId:req.params.eid});
    fights.sort((a,b)=>(b.isMain?1:0)-(a.isMain?1:0));
    res.json(fights);
  }catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/events/:eid/fights',requireAdmin,async(req,res)=>{
  try{
    const{fighterA,fighterB,oddsA,oddsB,card}=req.body;
    if(!fighterA||!fighterB) return res.status(400).json({error:'Both fighters required'});
    res.json(await db.fights.insert({eventId:req.params.eid,fighterA:fighterA.trim(),fighterB:fighterB.trim(),oddsA:parseFloat(oddsA)||null,oddsB:parseFloat(oddsB)||null,card:card||'Prelims',isMain:card==='Main',result:null,createdAt:new Date()}));
  }catch(e){res.status(500).json({error:e.message});}
});
app.put('/api/fights/:id',requireAdmin,async(req,res)=>{
  try{
    const{fighterA,fighterB,oddsA,oddsB,card,result}=req.body;
    const update={};
    if(fighterA!==undefined) update.fighterA=fighterA.trim();
    if(fighterB!==undefined) update.fighterB=fighterB.trim();
    if(oddsA!==undefined) update.oddsA=parseFloat(oddsA)||null;
    if(oddsB!==undefined) update.oddsB=parseFloat(oddsB)||null;
    if(card!==undefined){update.card=card;update.isMain=card==='Main';}
    if(result!==undefined) update.result=result||null;
    await db.fights.update({_id:req.params.id},{$set:update});
    // Only recalc units for picks that have NO seeded unit record (i.e. manually added picks)
    if(result!==undefined){
      const fightDoc=await db.fights.findOne({_id:req.params.id});
      const fightPicks=await db.picks.find({fightId:req.params.id});
      const existingUnits=await db.units.find({fightId:req.params.id});
      const isDraw=result==='Draw'||!result;

      for(const p of fightPicks){
        const existingUnit=existingUnits.find(u=>u.username===p.username);
        // Don't overwrite seeded unit records (they have accurate odds-based values from spreadsheet)
        if(existingUnit && existingUnit.seeded) continue;

        let profit=0;
        if(!isDraw && result){
          const pickedA=p.pick.trim()===fightDoc.fighterA.trim();
          const odds=pickedA?fightDoc.oddsA:fightDoc.oddsB;
          const won=p.pick.trim()===result.trim();
          if(won) profit=odds&&odds>0 ? odds/100 : (odds ? 100/Math.abs(odds) : 1);
          else profit=-1;
        }
        if(existingUnit){
          await db.units.update({_id:existingUnit._id},{$set:{profit}});
        } else {
          await db.units.insert({fightId:req.params.id,username:p.username,profit,isMain:fightDoc?.isMain||false,createdAt:new Date()});
        }
      }
    }
    res.json({ok:true});
  }catch(e){res.status(500).json({error:e.message});}
});
app.delete('/api/fights/:id',requireAdmin,async(req,res)=>{
  try{
    await db.picks.remove({fightId:req.params.id},{multi:true});
    await db.units.remove({fightId:req.params.id},{multi:true});
    await db.fights.remove({_id:req.params.id});
    res.json({ok:true});
  }catch(e){res.status(500).json({error:e.message});}
});

// PICKS
app.get('/api/events/:eid/picks',requireAuth,async(req,res)=>{
  try{
    const fights=await db.fights.find({eventId:req.params.eid});
    const ids=fights.map(f=>f._id);
    res.json({picks:await db.picks.find({fightId:{$in:ids}}),units:await db.units.find({fightId:{$in:ids}})});
  }catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/picks',requireAuth,async(req,res)=>{
  try{
    const{fightId,pick}=req.body;
    const fight=await db.fights.findOne({_id:fightId});
    if(!fight) return res.status(404).json({error:'Fight not found'});
    const existing=await db.picks.findOne({fightId,username:req.session.username});
    if(existing) await db.picks.update({_id:existing._id},{$set:{pick,updatedAt:new Date()}});
    else await db.picks.insert({fightId,username:req.session.username,pick,createdAt:new Date()});
    if(fight.result){
      const isDraw=fight.result==='Draw';
      let profit=0;
      if(!isDraw){
        const pickedA=pick.trim()===fight.fighterA.trim();
        const odds=pickedA?fight.oddsA:fight.oddsB;
        const won=pick.trim()===fight.result.trim();
        if(won) profit=odds&&odds>0?odds/100:(odds?100/Math.abs(odds):1);
        else profit=-1;
      }
      const eu=await db.units.findOne({fightId,username:req.session.username});
      if(eu) await db.units.update({_id:eu._id},{$set:{profit}});
      else await db.units.insert({fightId,username:req.session.username,profit,isMain:fight.isMain||false,createdAt:new Date()});
    }
    res.json({ok:true});
  }catch(e){res.status(500).json({error:e.message});}
});

// LEADERBOARD
app.get('/api/leaderboard',async(_,res)=>{
  try{
    const users=await db.users.find({isAdmin:{$ne:true}});
    const allFights=await db.fights.find({result:{$ne:null}});
    const scoredFights=allFights.filter(f=>f.result!=='Draw'&&f.result!=='');
    const picks=await db.picks.find({fightId:{$in:scoredFights.map(f=>f._id)}});
    const unitRecs=await db.units.find({fightId:{$in:allFights.map(f=>f._id)}});
    const stats={};
    users.forEach(u=>{stats[u.username]={username:u.username,allWins:0,allTotal:0,mainWins:0,mainTotal:0,allUnits:0,mainUnits:0};});
    for(const fight of scoredFights){
      const fPicks=picks.filter(p=>p.fightId===fight._id);
      for(const p of fPicks){
        if(!stats[p.username]) continue;
        const won=p.pick.trim()===fight.result.trim();
        stats[p.username].allTotal++;
        if(won) stats[p.username].allWins++;
        if(fight.isMain){stats[p.username].mainTotal++;if(won)stats[p.username].mainWins++;}
      }
    }
    for(const ur of unitRecs){
      if(stats[ur.username]===undefined) continue;
      stats[ur.username].allUnits+=ur.profit;
      if(ur.isMain) stats[ur.username].mainUnits+=ur.profit;
    }
    const sorted=Object.values(stats).sort((a,b)=>b.mainWins-a.mainWins||b.allWins-a.allWins);
    sorted.forEach(s=>{
      s.winPct=s.allTotal>0?s.allWins/s.allTotal:0;
      s.mainWinPct=s.mainTotal>0?s.mainWins/s.mainTotal:0;
      s.allRoi=s.allTotal>0?(s.allUnits/s.allTotal)*100:0;
      s.mainRoi=s.mainTotal>0?(s.mainUnits/s.mainTotal)*100:0;
    });
    res.json(sorted);
  }catch(e){res.status(500).json({error:e.message});}
});

// EVENT BREAKDOWN
app.get('/api/event-breakdown',async(_,res)=>{
  try{
    const events=await db.events.find({}).sort({date:1});
    const fights=await db.fights.find({});
    const unitRecs=await db.units.find({});
    const users=await db.users.find({isAdmin:{$ne:true}});
    const usernames=users.map(u=>u.username);
    const breakdown=events.map(ev=>{
      const ids=fights.filter(f=>f.eventId===ev._id).map(f=>f._id);
      const evU=unitRecs.filter(u=>ids.includes(u.fightId));
      const perUser={};usernames.forEach(u=>perUser[u]=0);
      evU.forEach(u=>{if(perUser[u.username]!==undefined)perUser[u.username]+=u.profit;});
      return{event:ev.name,date:ev.date,perUser};
    });
    res.json({breakdown,users:usernames});
  }catch(e){res.status(500).json({error:e.message});}
});

// FIGHTER PROFILE
app.get('/api/fighter/:name',async(req,res)=>{
  try{
    const name=decodeURIComponent(req.params.name);
    const re=new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}$`,'i');
    const fights=await db.fights.find({$or:[{fighterA:re},{fighterB:re}]});
    const events=await db.events.find({});
    const evMap={};events.forEach(e=>evMap[e._id]=e);
    const fightIds=fights.map(f=>f._id);
    const picks=await db.picks.find({fightId:{$in:fightIds}});
    const unitRecs=await db.units.find({fightId:{$in:fightIds}});
    let fighterAllUnits=0,fighterMainUnits=0;
    const data=fights.map(f=>{
      const ev=evMap[f.eventId]||{};
      const isA=f.fighterA.toLowerCase()===name.toLowerCase();
      const opponent=isA?f.fighterB:f.fighterA;
      const myOdds=isA?f.oddsA:f.oddsB;
      let outcome=null;
      if(f.result) outcome=f.result==='Draw'?'Draw':(f.result.toLowerCase()===name.toLowerCase()?'W':'L');
      let unitIfBet=null;
      if(f.result&&f.result!=='Draw'&&myOdds){
        const won=f.result.toLowerCase()===name.toLowerCase();
        unitIfBet=won?(myOdds>0?myOdds/100:100/Math.abs(myOdds)):-1;
        fighterAllUnits+=unitIfBet;
        if(f.isMain) fighterMainUnits+=unitIfBet;
      }
      return{event:ev.name||'',date:ev.date||'',opponent,myOdds,outcome,unitIfBet,card:f.card,fighterA:f.fighterA,fighterB:f.fighterB,result:f.result,picks:picks.filter(p=>p.fightId===f._id),units:unitRecs.filter(u=>u.fightId===f._id)};
    }).sort((a,b)=>new Date(b.date)-new Date(a.date));
    res.json({fights:data,fighterAllUnits,fighterMainUnits});
  }catch(e){res.status(500).json({error:e.message});}
});

// CHANGE PASSWORD
app.post('/api/change-password', requireAuth, async(req,res)=>{
  try{
    const {currentPassword, newPassword} = req.body;
    if(!newPassword || newPassword.length < 4) return res.status(400).json({error:'New password must be at least 4 characters'});
    const u = await db.users.findOne({_id: req.session.userId});
    if(!u) return res.status(404).json({error:'User not found'});
    if(!await bcrypt.compare(currentPassword, u.password)) return res.status(401).json({error:'Current password is incorrect'});
    await db.users.update({_id: req.session.userId},{$set:{password: await bcrypt.hash(newPassword,10)}});
    res.json({ok:true});
  }catch(e){res.status(500).json({error:e.message});}
});

// ADMIN TEST — helps diagnose session issues
app.get('/api/admin/test', requireAdmin, (req,res) => res.json({ok:true, username:req.session.username}));

// ADMIN USERS
app.get('/api/admin/users',requireAdmin,async(_,res)=>{
  try{const u=await db.users.find({}).sort({createdAt:1});res.json(u.map(u=>({_id:u._id,username:u.username,isAdmin:u.isAdmin,createdAt:u.createdAt})));}catch(e){res.status(500).json({error:e.message});}
});
app.delete('/api/admin/users/:id',requireAdmin,async(req,res)=>{
  try{await db.users.remove({_id:req.params.id});res.json({ok:true});}catch(e){res.status(500).json({error:e.message});}
});

// RENAME FIGHTER
app.post('/api/admin/rename-fighter',requireAdmin,async(req,res)=>{
  try{
    const{oldName,newName}=req.body;
    if(!oldName||!newName) return res.status(400).json({error:'Both names required'});
    const old=oldName.trim(),nw=newName.trim();
    const asA=await db.fights.find({fighterA:old});
    const asB=await db.fights.find({fighterB:old});
    const asResult=await db.fights.find({result:old});
    const asPick=await db.picks.find({pick:old});
    for(const f of asA) await db.fights.update({_id:f._id},{$set:{fighterA:nw}});
    for(const f of asB) await db.fights.update({_id:f._id},{$set:{fighterB:nw}});
    for(const f of asResult) await db.fights.update({_id:f._id},{$set:{result:nw}});
    for(const p of asPick) await db.picks.update({_id:p._id},{$set:{pick:nw}});
    res.json({ok:true,asA:asA.length,asB:asB.length,asResult:asResult.length,asPick:asPick.length});
  }catch(e){res.status(500).json({error:e.message});}
});

// SERVE FRONTEND — must be after all API routes
app.use(express.static('public'));

(async()=>{
  await seedAdmin();
  await seedDatabase();
  app.listen(process.env.PORT||3000,()=>console.log('FightPool 2026 → http://localhost:3000'));
})();
