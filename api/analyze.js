export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
 
  const { gameName, tagLine, region } = req.query;
  if (!gameName || !tagLine || !region) {
    return res.status(400).json({ error: 'Missing gameName, tagLine or region' });
  }
 
  const API_KEY = process.env.RIOT_API_KEY;
  if (!API_KEY) return res.status(500).json({ error: 'Server configuration error. Please try again!' });
 
  const ROUTING = {
    euw1:'europe', eun1:'europe', tr1:'europe', ru:'europe',
    na1:'americas', br1:'americas', la1:'americas', la2:'americas',
    kr:'asia', jp1:'asia', oc1:'sea'
  };
  const route = ROUTING[region] || 'europe';
 
  try {
    // 1. Get PUUID via Riot ID (gameName#tagLine)
    const accountRes = await fetch(
      `https://${route}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`,
      { headers: { 'X-Riot-Token': API_KEY } }
    );
    if (!accountRes.ok) {
      if (accountRes.status === 404) return res.status(404).json({ error: `Player "${gameName}#${tagLine}" not found. Check your name and tag!` });
      if (accountRes.status === 429) return res.status(429).json({ error: 'Too many requests — wait a moment and try again!' });
      return res.status(accountRes.status).json({ error: 'Could not find player. Please try again!' });
    }
    const account = await accountRes.json();
    const puuid = account.puuid;
 
    // 2. Get summoner data
    const sumRes = await fetch(
      `https://${region}.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${puuid}`,
      { headers: { 'X-Riot-Token': API_KEY } }
    );
    const sumData = sumRes.ok ? await sumRes.json() : {};
 
    // 3. Get rank
    const rankRes = await fetch(
      `https://${region}.api.riotgames.com/lol/league/v4/entries/by-summoner/${sumData.id}`,
      { headers: { 'X-Riot-Token': API_KEY } }
    );
    const rankData = rankRes.ok ? await rankRes.json() : [];
    const soloQ = rankData.find(e => e.queueType === 'RANKED_SOLO_5x5') || null;
 
    // 4. Get match IDs
    const matchRes = await fetch(
      `https://${route}.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?queue=420&start=0&count=20`,
      { headers: { 'X-Riot-Token': API_KEY } }
    );
    if (!matchRes.ok) return res.status(400).json({ error: 'Could not load match history. Play some ranked games first!' });
    const matchIds = await matchRes.json();
    if (!matchIds.length) return res.status(400).json({ error: 'No ranked games found! Play some ranked games first 😄' });
 
    // 5. Fetch last 10 matches
    const matches = await Promise.all(
      matchIds.slice(0, 10).map(id =>
        fetch(`https://${route}.api.riotgames.com/lol/match/v5/matches/${id}`,
          { headers: { 'X-Riot-Token': API_KEY } }).then(r => r.json())
      )
    );
 
    // 6. Extract stats
    const stats = extractStats(matches, puuid);
 
    return res.status(200).json({
      gameName: account.gameName,
      tagLine: account.tagLine,
      rank: soloQ,
      stats
    });
 
  } catch (err) {
    return res.status(500).json({ error: 'Something went wrong. Please try again!' });
  }
}
 
function extractStats(matches, puuid) {
  let wins=0,losses=0,totalKills=0,totalDeaths=0,totalAssists=0;
  let totalCS=0,totalGold=0,totalVision=0,totalGameLen=0;
  let earlyDeaths=0,games=0,champCounts={},roleGames={};
 
  matches.forEach(m => {
    if (!m.info) return;
    const p = m.info.participants.find(x => x.puuid === puuid);
    if (!p) return;
    games++;
    if (p.win) wins++; else losses++;
    totalKills+=p.kills; totalDeaths+=p.deaths; totalAssists+=p.assists;
    totalCS+=p.totalMinionsKilled+(p.neutralMinionsKilled||0);
    totalGold+=p.goldEarned;
    totalVision+=p.visionScore||0;
    totalGameLen+=m.info.gameDuration;
    champCounts[p.championName]=(champCounts[p.championName]||0)+1;
    const role=p.teamPosition||p.lane||'UNKNOWN';
    roleGames[role]=(roleGames[role]||0)+1;
    const gameMins=m.info.gameDuration/60;
    if(gameMins<30&&p.deaths>=4) earlyDeaths++;
  });
 
  const g=games||1;
  const avgGameMin=totalGameLen/g/60;
  const topChamp=Object.entries(champCounts).sort((a,b)=>b[1]-a[1])[0]?.[0]||'Unknown';
  const topRole=Object.entries(roleGames).sort((a,b)=>b[1]-a[1])[0]?.[0]||'Unknown';
 
  return {
    games, wins, losses,
    winRate: Math.round(wins/g*100),
    kda: totalDeaths>0?((totalKills+totalAssists)/totalDeaths).toFixed(2):'Perfect',
    deathsPerGame: (totalDeaths/g).toFixed(1),
    killsPerGame: (totalKills/g).toFixed(1),
    csPerMin: parseFloat((totalCS/g/avgGameMin).toFixed(1)),
    visionPerGame: parseFloat((totalVision/g).toFixed(1)),
    goldPerMin: Math.round(totalGold/g/avgGameMin),
    topChamp, topRole,
    earlyDeathRate: Math.round(earlyDeaths/g*100),
    avgGameMin: avgGameMin.toFixed(0)
  };
}
 
