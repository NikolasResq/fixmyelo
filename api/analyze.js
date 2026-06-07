export const config = { runtime: 'edge' };

export default async function handler(req) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers });
  }

  const { searchParams } = new URL(req.url);
  const gameName = searchParams.get('gameName');
  const tagLine = searchParams.get('tagLine');
  const region = searchParams.get('region');

  if (!gameName || !tagLine || !region) {
    return new Response(JSON.stringify({ error: 'Missing parameters' }), { status: 400, headers });
  }

  const RIOT_KEY = process.env.RIOT_API_KEY;
  if (!RIOT_KEY) {
    return new Response(JSON.stringify({ error: 'Server config error. Please try again!' }), { status: 500, headers });
  }

  const ROUTING = {
    euw1:'europe', eun1:'europe', tr1:'europe', ru:'europe',
    na1:'americas', br1:'americas', la1:'americas', la2:'americas',
    kr:'asia', jp1:'asia', oc1:'sea'
  };
  const route = ROUTING[region] || 'europe';

  try {
    // 1. Get PUUID
    const accountRes = await fetch(
      `https://${route}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`,
      { headers: { 'X-Riot-Token': RIOT_KEY } }
    );

    if (!accountRes.ok) {
      const status = accountRes.status;
      if (status === 404) return new Response(JSON.stringify({ error: `Player "${gameName}#${tagLine}" not found. Check your name and tag!` }), { status: 404, headers });
      if (status === 403) return new Response(JSON.stringify({ error: 'API key issue on our end — please try again later!' }), { status: 403, headers });
      if (status === 429) return new Response(JSON.stringify({ error: 'Too many requests — please wait a moment and try again!' }), { status: 429, headers });
      return new Response(JSON.stringify({ error: `Could not find player. Please try again!` }), { status: 400, headers });
    }

    const account = await accountRes.json();
    const puuid = account.puuid;

    // 2. Get summoner
    const sumRes = await fetch(
      `https://${region}.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${puuid}`,
      { headers: { 'X-Riot-Token': RIOT_KEY } }
    );
    const sumData = sumRes.ok ? await sumRes.json() : {};

    // 3. Get rank
    const rankData = sumData.id ? await fetch(
      `https://${region}.api.riotgames.com/lol/league/v4/entries/by-summoner/${sumData.id}`,
      { headers: { 'X-Riot-Token': RIOT_KEY } }
    ).then(r => r.json()) : [];
    const soloQ = Array.isArray(rankData) ? rankData.find(e => e.queueType === 'RANKED_SOLO_5x5') || null : null;

    // 4. Get match IDs
    const matchRes = await fetch(
      `https://${route}.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?queue=420&start=0&count=20`,
      { headers: { 'X-Riot-Token': RIOT_KEY } }
    );
    if (!matchRes.ok) return new Response(JSON.stringify({ error: 'No ranked match history found. Play some ranked games first!' }), { status: 400, headers });

    const matchIds = await matchRes.json();
    if (!matchIds.length) return new Response(JSON.stringify({ error: 'No ranked games found! Play some ranked games first 😄' }), { status: 400, headers });

    // 5. Fetch matches
    const matches = await Promise.all(
      matchIds.slice(0, 10).map(id =>
        fetch(`https://${route}.api.riotgames.com/lol/match/v5/matches/${id}`,
          { headers: { 'X-Riot-Token': RIOT_KEY } }).then(r => r.json())
      )
    );

    // 6. Extract stats
    const stats = extractStats(matches, puuid);

    // 7. Rule-based coaching report (free, no AI cost)
    const report = generateReport(stats, soloQ);

    return new Response(JSON.stringify({
      gameName: account.gameName,
      tagLine: account.tagLine,
      rank: soloQ,
      stats,
      report
    }), { status: 200, headers });

  } catch (err) {
    return new Response(JSON.stringify({ error: 'Something went wrong on our end. Please try again!' }), { status: 500, headers });
  }
}

// ── RULE-BASED COACHING ENGINE ──
function generateReport(stats, soloQ) {
  const deaths = parseFloat(stats.deathsPerGame);
  const cs = stats.csPerMin;
  const vision = stats.visionPerGame;
  const kda = stats.kda === 'Perfect' ? 10 : parseFloat(stats.kda);
  const wr = stats.winRate;
  const earlyDeaths = stats.earlyDeathRate;
  const role = stats.topRole;
  const champ = stats.topChamp;

  // Find the worst stat and build report around it
  let habit, desc, evidence, fixSteps, champRecs, lpLost, encouragement;

  if (deaths > 5) {
    // Very high deaths
    habit = "Dying Way Too Much Every Game 💀";
    desc = `You're averaging ${deaths} deaths per game which is really hurting your win rate. Every time you die you're giving your opponent gold, XP advantage, and free objectives. The good news is this is one of the fastest habits to fix once you're aware of it!`;
    evidence = `Your ${deaths} deaths/game is significantly above the recommended 3 or under. Players who fixed this habit typically climb 1-2 divisions within 2-3 weeks.`;
    lpLost = "35";
    fixSteps = [
      { title: "Respect the enemy's kill pressure", desc: "When you're low HP or they have ultimates up — back off. It's better to lose 20 CS than die and give them 300 gold. Ask yourself before every fight: can I win this?" },
      { title: "Ward before you walk into danger", desc: "Most deaths happen because of unexpected ganks. Before moving into river or enemy jungle, place a ward first. No vision = no business being there." },
      { title: "Play the first 15 minutes safe", desc: "Focus entirely on surviving lane. Don't force fights. Farm under tower if needed. Your job early is to not feed — snowball comes after." }
    ];
    champRecs = [
      { name: champ === 'Unknown' ? 'Malphite' : champ, reason: "Stick with what you know but play it safer" },
      { name: "Lux", reason: "Safe range, can play from distance, hard to gank" },
      { name: "Caitlyn", reason: "Longest auto range ADC, easy to stay safe in lane" }
    ];
    encouragement = `You have a ${wr}% win rate which shows real potential — cutting deaths in half could push you to ${wr + 15}%+ easily! 🔥`;

  } else if (cs < 5) {
    // Very low CS
    habit = "Missing Too Many CS Every Game 🪙";
    desc = `You're only getting ${cs} CS per minute which means you're leaving huge amounts of gold on the table. CS is free gold that directly translates to items and power spikes. Missing CS is like handing your opponent a free kill every few minutes.`;
    evidence = `At ${cs} CS/min you're earning roughly ${Math.round(cs * 20 * 14)} gold per game from minions. A good player earns ${Math.round(7 * 20 * 14)} gold. That's a ${Math.round((7 - cs) * 20 * 14)} gold deficit per game!`;
    lpLost = "28";
    fixSteps = [
      { title: "Last hit practice in custom games", desc: "Spend 10 minutes before your session in a custom game with no abilities — just last hitting. Try to hit 7+ CS per minute. This builds the muscle memory you need." },
      { title: "Focus CS over kills", desc: "Kills are flashy but 10 CS = 1 kill in gold. Stop chasing kills and prioritize clearing waves. The gold difference will shock you." },
      { title: "Freeze and slow push", desc: "Learn to control the wave near your tower when you're behind. A frozen wave is safe CS. A slow push gives you dive protection." }
    ];
    champRecs = [
      { name: "Annie", reason: "Q resets on kill, easy last hitting for beginners" },
      { name: "Sivir", reason: "AoE Q makes wave clear simple and satisfying" },
      { name: "Malzahar", reason: "E on minions makes CSing almost automatic" }
    ];
    encouragement = `If you get to 7 CS/min you'll have a huge gold advantage in every game — you're closer than you think! 💪`;

  } else if (vision < 15) {
    // Very low vision
    habit = "Playing Blind — Zero Vision Control 👁️";
    desc = `You're averaging only ${vision} vision score per game which means you're playing most of the game without knowing where the enemy is. Low vision leads to getting caught, missing objectives, and losing team fights because you're always surprised.`;
    evidence = `Your ${vision} vision score is well below the recommended 25+. Players with low vision get caught out and die without reason in ${earlyDeaths}% of your games.`;
    lpLost = "22";
    fixSteps = [
      { title: "Buy a Control Ward every back", desc: "Every single time you go back to base, buy a Control Ward (75 gold). Place it in dragon pit or enemy jungle. This one habit alone raises your vision score by 8-10 per game." },
      { title: "Use your trinket on cooldown", desc: "Your yellow trinket ward refreshes every 3-4 minutes. Never let it sit on cooldown. Place it proactively in river or bush before you need it." },
      { title: "Ward before objectives spawn", desc: "Dragon spawns at 5 minutes, Baron at 20. Ward those areas 60 seconds before they spawn. This one habit wins teamfights before they even start." }
    ];
    champRecs = [
      { name: "Jhin", reason: "W provides free vision in important areas" },
      { name: "Ashe", reason: "E and R give massive map vision utility" },
      { name: "Twisted Fate", reason: "Ultimate reveals the whole map — perfect for low-vision players" }
    ];
    encouragement = `Warding more costs you nothing — just 75 gold for a Control Ward — and the difference it makes is massive! 🗺️`;

  } else if (wr < 45) {
    // Low win rate despite decent stats
    habit = "Good Stats But Losing Games — Macro Issue 🗺️";
    desc = `Your individual stats aren't bad but you're only winning ${wr}% of your games. This usually means you're winning your lane but losing the game — a classic macro problem. You need to translate your lead into actual objectives and wins.`;
    evidence = `With a KDA of ${kda} and ${deaths} deaths/game your laning is decent, but your ${wr}% win rate shows the gold isn't converting into wins. Objectives win games, not kills.`;
    lpLost = "30";
    fixSteps = [
      { title: "After winning your lane — rotate", desc: "When you're ahead, don't just keep killing your laner. Roam to the nearest lane or take tower. Spread your advantage across the whole map." },
      { title: "Always take objectives after kills", desc: "After a kill ALWAYS ask — what objective can we take? Dragon, Baron, Rift Herald, tower. Kills that don't lead to objectives are wasted." },
      { title: "Group for Baron after 20 minutes", desc: "After 20 minutes stop splitting and group with your team. 5v5 with a lead wins games. Playing alone loses them no matter how fed you are." }
    ];
    champRecs = [
      { name: "Orianna", reason: "Ultimate forces team to group and win teamfights" },
      { name: "Jarvan IV", reason: "Easy objective control and team fight presence" },
      { name: "Amumu", reason: "Ult wins teamfights single-handedly when ahead" }
    ];
    encouragement = `You already have the mechanical skills — once your macro clicks you'll climb fast. Most players in your situation jump a full division quickly! 🚀`;

  } else {
    // Decent player — fine-tuning
    habit = `Inconsistency — Good Games Followed by Bad Ones 📊`;
    desc = `Your stats show you know how to play but you're not consistently performing at your peak. You have the skills to climb higher — the issue is mental consistency and decision-making under pressure.`;
    evidence = `With ${wr}% win rate and ${kda} KDA you have the fundamentals. But ${earlyDeaths}% early death rate shows you still have tilt or overaggression moments that cost you winnable games.`;
    lpLost = "18";
    fixSteps = [
      { title: "Limit yourself to 2-3 champions max", desc: "Stop playing 10 different champions. Pick 2-3 and master them completely. Consistency on fewer champions leads to faster rank climbing than variety." },
      { title: "Take a break after 2 losses", desc: "If you lose 2 games in a row — log off for 30 minutes. Tilt is real and it will cost you LP. Come back fresh." },
      { title: "Review one replay per day", desc: "Watch back your most recent loss for just 10 minutes. Find the ONE moment where the game was decided. Fix that pattern." }
    ];
    champRecs = [
      { name: stats.topChamp !== 'Unknown' ? stats.topChamp : 'Garen', reason: "Keep maining what you know — depth beats breadth" },
      { name: "Malphite", reason: "Simple, consistent, great in any meta" },
      { name: "Annie", reason: "Teaches fundamentals, consistent damage output" }
    ];
    encouragement = `You're closer to the next division than you think — consistency is the final piece of the puzzle! 🏆`;
  }

  return { habitTitle: habit, habitDesc: desc, evidence, lpLostPerWeek: lpLost, fixSteps, champRecs, encouragement };
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
    if((m.info.gameDuration/60)<30&&p.deaths>=4) earlyDeaths++;
  });

  const g=games||1;
  const avgGameMin=(totalGameLen/g/60)||1;
  const topChamp=Object.entries(champCounts).sort((a,b)=>b[1]-a[1])[0]?.[0]||'Unknown';
  const topRole=Object.entries(roleGames).sort((a,b)=>b[1]-a[1])[0]?.[0]||'Unknown';

  return {
    games,wins,losses,
    winRate:Math.round(wins/g*100),
    kda:totalDeaths>0?((totalKills+totalAssists)/totalDeaths).toFixed(2):'Perfect',
    deathsPerGame:(totalDeaths/g).toFixed(1),
    killsPerGame:(totalKills/g).toFixed(1),
    csPerMin:parseFloat((totalCS/g/avgGameMin).toFixed(1)),
    visionPerGame:parseFloat((totalVision/g).toFixed(1)),
    goldPerMin:Math.round(totalGold/g/avgGameMin),
    topChamp,topRole,
    earlyDeathRate:Math.round(earlyDeaths/g*100),
    avgGameMin:avgGameMin.toFixed(0)
  };
}
