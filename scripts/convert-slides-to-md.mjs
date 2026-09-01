import fs from 'fs';
import path from 'path';

function htmlToMarkdown(html) {
  let content = html;

  // Extract main/body
  const mainMatch = content.match(/<main[\s\S]*?<\/main>/i);
  if (mainMatch) {
    content = mainMatch[0];
  } else {
    const bodyMatch = content.match(/<body[\s\S]*?<\/body>/i);
    if (bodyMatch) content = bodyMatch[0];
  }

  // Remove topnav
  content = content.replace(/<nav[\s\S]*?<\/nav>/gi, '');

  // Extract Hero
  content = content.replace(/<div class="hero">[\s\S]*?<\/h1>\s*(?:<p>[\s\S]*?<\/p>)?\s*<\/div>/i, (match) => {
    let kicker = '';
    const kickerMatch = match.match(/<div class="kicker">([\s\S]*?)<\/div>/i);
    if (kickerMatch) kicker = cleanInline(kickerMatch[1]);

    let h1 = '';
    const h1Match = match.match(/<h1>([\s\S]*?)<\/h1>/i);
    if (h1Match) h1 = cleanInline(h1Match[1]);

    let desc = '';
    const pMatch = match.match(/<p>([\s\S]*?)<\/p>/i);
    if (pMatch) desc = cleanInline(pMatch[1]);

    let titleLine = kicker ? `# ${kicker} — ${h1}` : `# ${h1}`;
    return `\n\n${titleLine}\n\n${desc ? `> ${desc}\n\n` : ''}`;
  });

  // Extract Chips
  content = content.replace(/<div class="chips">([\s\S]*?)<\/div>/gi, (match, inner) => {
    const chips = [];
    const chipMatches = inner.matchAll(/<span class="chip">([\s\S]*?)<\/span>/gi);
    for (const cm of chipMatches) {
      chips.push(`- **${cleanInline(cm[1])}**`);
    }
    return `\n\n### 📌 หัวข้อหลักในบทนี้:\n${chips.join('\n')}\n\n`;
  });

  // Convert SVG Figures
  content = content.replace(/<figure[^>]*>([\s\S]*?)<\/figure>/gi, (match, inner) => {
    let figcaption = '';
    const capMatch = inner.match(/<figcaption>([\s\S]*?)<\/figcaption>/i);
    if (capMatch) figcaption = cleanInline(capMatch[1]);

    const svgTexts = [];
    const textMatches = inner.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/gi);
    for (const tm of textMatches) {
      const txt = cleanInline(tm[1]);
      if (txt && !svgTexts.includes(txt)) svgTexts.push(txt);
    }

    let out = `\n\n> 📊 **แผนภาพ: ${figcaption || 'Architecture Diagram'}**\n`;
    if (svgTexts.length > 0) {
      out += `>\n> *ข้อความ/ลำดับในแผนภาพ:*\n`;
      for (const t of svgTexts) {
        out += `> - ${t}\n`;
      }
    }
    out += `\n\n`;
    return out;
  });

  // Convert Boxes
  content = content.replace(/<div class="box\s+([^"]+)">([\s\S]*?)<\/div>/gi, (match, boxType, inner) => {
    let lab = '';
    const labMatch = inner.match(/<span class="lab">([\s\S]*?)<\/span>/i);
    if (labMatch) {
      lab = cleanInline(labMatch[1]);
      inner = inner.replace(/<span class="lab">[\s\S]*?<\/span>/i, '');
    }

    let prefix = '💡';
    let title = 'ข้อสังเกต';
    if (boxType.includes('trap')) {
      prefix = '⚠️';
      title = 'จุดที่ข้อสอบชอบถาม / กับดัก';
    } else if (boxType.includes('errata')) {
      prefix = '🛑';
      title = 'สไลด์เขียนผิด (Slide Errata)';
    } else if (boxType.includes('why')) {
      prefix = '🧠';
      title = 'เหตุผล / Mental Model';
    } else if (boxType.includes('base')) {
      prefix = '🎯';
      title = 'เป้าหมายและสรุป';
    } else if (boxType.includes('link-box')) {
      prefix = '🔗';
      title = 'การเชื่อมโยงกับบทอื่น';
    }

    const boxContent = cleanBlock(inner);
    const indented = boxContent.split('\n').map(line => line.trim() ? `> ${line}` : '>').join('\n');
    return `\n\n> ${prefix} **${lab ? lab : title}**\n${indented}\n\n`;
  });

  // Convert Tables
  content = content.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (match, tableInner) => {
    return '\n\n' + convertTable(tableInner) + '\n\n';
  });

  // Convert Headings
  content = content.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (m, c) => `\n\n# ${cleanInline(c)}\n\n`);
  content = content.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (m, c) => `\n\n## ${cleanInline(c)}\n\n`);
  content = content.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (m, c) => `\n\n### ${cleanInline(c)}\n\n`);
  content = content.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, (m, c) => `\n\n#### ${cleanInline(c)}\n\n`);

  // Convert Code blocks
  content = content.replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, (m, c) => {
    return `\n\n\`\`\`typescript\n${decodeHtml(c).trim()}\n\`\`\`\n\n`;
  });
  content = content.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (m, c) => {
    return `\n\n\`\`\`\n${decodeHtml(c).trim()}\n\`\`\`\n\n`;
  });

  // Convert Lists
  content = content.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, (m, c) => {
    const items = [];
    const liMatches = c.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi);
    for (const li of liMatches) {
      items.push(`- ${cleanInline(li[1])}`);
    }
    return `\n\n${items.join('\n')}\n\n`;
  });

  content = content.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (m, c) => {
    const items = [];
    let idx = 1;
    const liMatches = c.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi);
    for (const li of liMatches) {
      items.push(`${idx++}. ${cleanInline(li[1])}`);
    }
    return `\n\n${items.join('\n')}\n\n`;
  });

  // Convert Details
  content = content.replace(/<details[^>]*>([\s\S]*?)<\/details>/gi, (m, c) => {
    let summary = 'รายละเอียด';
    const sumMatch = c.match(/<summary[^>]*>([\s\S]*?)<\/summary>/i);
    if (sumMatch) {
      summary = cleanInline(sumMatch[1]);
      c = c.replace(/<summary[^>]*>[\s\S]*?<\/summary>/i, '');
    }
    return `\n\n<details>\n<summary><b>${summary}</b></summary>\n\n${cleanBlock(c)}\n</details>\n\n`;
  });

  // Convert Paragraphs
  content = content.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (m, c) => `\n\n${cleanInline(c)}\n\n`);

  // Strip remaining tags
  content = content.replace(/<\/?(div|section|main|span|header|footer|aside|svg|g|path|rect|circle|line|defs|marker)[^>]*>/gi, '');
  content = content.replace(/&amp;/g, '&')
                   .replace(/&lt;/g, '<')
                   .replace(/&gt;/g, '>')
                   .replace(/&quot;/g, '"')
                   .replace(/&#39;/g, "'")
                   .replace(/&nbsp;/g, ' ');

  // Clean trailing spaces and excessive blank lines
  content = content.split('\n').map(line => line.trimEnd()).join('\n');
  content = content.replace(/\n{3,}/g, '\n\n').trim();

  return content + '\n';
}

function cleanInline(str) {
  if (!str) return '';
  return str
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (m, c) => `\`${decodeHtml(c)}\``)
    .replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, (m, c) => `**${cleanInline(c)}**`)
    .replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, (m, c) => `**${cleanInline(c)}**`)
    .replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, (m, c) => `*${cleanInline(c)}*`)
    .replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, (m, c) => `*${cleanInline(c)}*`)
    .replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (m, href, text) => `[${cleanInline(text)}](${href})`)
    .replace(/<span class="g"[^>]*>([\s\S]*?)<\/span>/gi, (m, c) => ` *(${cleanInline(c)})*`)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function cleanBlock(str) {
  if (!str) return '';
  return str
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (m, c) => `\n${cleanInline(c)}\n`)
    .replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, (m, c) => {
      const items = [];
      const liMatches = c.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi);
      for (const li of liMatches) items.push(`- ${cleanInline(li[1])}`);
      return `\n${items.join('\n')}\n`;
    })
    .replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (m, c) => {
      const items = [];
      let idx = 1;
      const liMatches = c.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi);
      for (const li of liMatches) items.push(`${idx++}. ${cleanInline(li[1])}`);
      return `\n${items.join('\n')}\n`;
    })
    .replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, (m, c) => `\n\`\`\`typescript\n${decodeHtml(c).trim()}\n\`\`\`\n`)
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (m, c) => `\n\`\`\`\n${decodeHtml(c).trim()}\n\`\`\`\n`)
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeHtml(str) {
  if (!str) return '';
  return str
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function convertTable(html) {
  const rows = [];
  const trMatches = html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi);
  for (const tr of trMatches) {
    const cells = [];
    const cellMatches = tr[1].matchAll(/<(?:td|th)[^>]*>([\s\S]*?)<\/(?:td|th)>/gi);
    for (const c of cellMatches) {
      cells.push(cleanInline(c[1]).replace(/\|/g, '\\|').replace(/\n/g, ' '));
    }
    if (cells.length > 0) rows.push(cells);
  }

  if (rows.length === 0) return '';

  const maxCols = Math.max(...rows.map(r => r.length));
  for (const r of rows) {
    while (r.length < maxCols) r.push('');
  }

  let md = '| ' + rows[0].join(' | ') + ' |\n';
  md += '| ' + rows[0].map(() => '---').join(' | ') + ' |\n';

  for (let i = 1; i < rows.length; i++) {
    md += '| ' + rows[i].join(' | ') + ' |\n';
  }
  return md;
}

const slidesDir = 'docs/slides';
const files = [
  '01-architecture-docker.html',
  '02-nestjs-di.html',
  '03-database.html',
  '04-redis.html',
  '05-async-queue.html',
  '06-scaling.html'
];

for (const file of files) {
  const srcPath = path.join(slidesDir, file);
  const dstPath = path.join(slidesDir, file.replace('.html', '.md'));
  const html = fs.readFileSync(srcPath, 'utf8');
  const md = htmlToMarkdown(html);
  fs.writeFileSync(dstPath, md, 'utf8');
  console.log(`Generated ${path.basename(dstPath)} (${md.length} bytes)`);
}
