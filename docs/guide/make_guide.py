"""Builds the Nightshift user guide PDF with ReportLab: python3 make_guide.py OUT.pdf

Screenshots live in docs/guide/img (taken from the app against demo plans).
"""
import math
import os
import sys
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (BaseDocTemplate, PageTemplate, Frame, Paragraph, Spacer, Table, TableStyle, Image,
                                Preformatted, PageBreak, KeepTogether, Flowable, NextPageTemplate, CondPageBreak)

OUT = sys.argv[1]
IMG = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'img')
pdfmetrics.registerFont(TTFont('Mono', '/System/Library/Fonts/Menlo.ttc', subfontIndex=0))
pdfmetrics.registerFont(TTFont('Mono-Bold', '/System/Library/Fonts/Menlo.ttc', subfontIndex=1))

NAVY = colors.HexColor('#1B2540')
INK = colors.HexColor('#2B2F38')
MUTED = colors.HexColor('#6B7280')
ACCENT = colors.HexColor('#5B5BD6')
AMBER = colors.HexColor('#F2A33A')
LIGHT = colors.HexColor('#F3F4F8')
LINE = colors.HexColor('#D9DCE5')
GREEN = colors.HexColor('#2E9E5B')
RED = colors.HexColor('#C9483C')
PURPLE = colors.HexColor('#8E44AD')

W, H = A4
MARGIN = 20 * mm
FULL = W - 2 * MARGIN

body = ParagraphStyle('body', fontName='Helvetica', fontSize=10.3, leading=15, textColor=INK, spaceAfter=6)
small = ParagraphStyle('small', parent=body, fontSize=8.8, leading=12, textColor=MUTED)
caption = ParagraphStyle('caption', parent=small, fontSize=8.4, leading=11, spaceBefore=3, spaceAfter=10)
lead = ParagraphStyle('lead', parent=body, fontSize=12, leading=18, textColor=INK, spaceAfter=10)
kicker = ParagraphStyle('kicker', fontName='Helvetica-Bold', fontSize=8.5, leading=11, textColor=ACCENT, spaceAfter=2)
h1 = ParagraphStyle('h1', fontName='Helvetica-Bold', fontSize=21, leading=26, textColor=NAVY, spaceAfter=10)
h2 = ParagraphStyle('h2', fontName='Helvetica-Bold', fontSize=13, leading=17, textColor=NAVY, spaceBefore=12, spaceAfter=5)
cell = ParagraphStyle('cell', parent=body, fontSize=9.4, leading=13, spaceAfter=0)
cellb = ParagraphStyle('cellb', parent=cell, fontName='Helvetica-Bold')
cellmono = ParagraphStyle('cellmono', parent=cell, fontName='Mono', fontSize=8.4, leading=12)
bullet = ParagraphStyle('bullet', parent=body, leftIndent=14, bulletIndent=3, spaceAfter=3)
codestyle = ParagraphStyle('code', fontName='Mono', fontSize=8.6, leading=12.5, textColor=NAVY)


def P(text, style=body):
    return Paragraph(text, style)


def bullets(items):
    return [Paragraph(item, bullet, bulletText='•') for item in items]


def m(text):
    """Inline monospace."""
    return f'<font name="Mono" size="8.8" color="#1B2540">{text}</font>'


def code(text):
    block = Preformatted(text.strip('\n'), codestyle)
    t = Table([[block]], colWidths=[FULL])
    t.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, -1), LIGHT), ('BOX', (0, 0), (-1, -1), 0.6, LINE),
        ('LEFTPADDING', (0, 0), (-1, -1), 9), ('RIGHTPADDING', (0, 0), (-1, -1), 9),
        ('TOPPADDING', (0, 0), (-1, -1), 7), ('BOTTOMPADDING', (0, 0), (-1, -1), 7)]))
    return KeepTogether([t, Spacer(1, 7)])


def table(rows, widths, header=True, mono_first=False, bold_first=False):
    data = []
    for i, row in enumerate(rows):
        styled = []
        for j, value in enumerate(row):
            if header and i == 0:
                styled.append(P(value, ParagraphStyle('th', parent=cellb, textColor=colors.white)))
            elif mono_first and j == 0:
                styled.append(P(value, cellmono))
            elif bold_first and j == 0:
                styled.append(P(value, cellb))
            else:
                styled.append(P(value, cell))
        data.append(styled)
    t = Table(data, colWidths=widths, repeatRows=1 if header else 0)
    style = [('VALIGN', (0, 0), (-1, -1), 'TOP'), ('LINEBELOW', (0, 0), (-1, -1), 0.4, LINE),
             ('LEFTPADDING', (0, 0), (-1, -1), 6), ('RIGHTPADDING', (0, 0), (-1, -1), 6),
             ('TOPPADDING', (0, 0), (-1, -1), 5), ('BOTTOMPADDING', (0, 0), (-1, -1), 5)]
    if header:
        style += [('BACKGROUND', (0, 0), (-1, 0), NAVY)]
        style += [('BACKGROUND', (0, r), (-1, r), LIGHT) for r in range(2, len(rows), 2)]
    t.setStyle(TableStyle(style))
    return KeepTogether([t, Spacer(1, 8)]) if len(rows) <= 12 else t


def callout(title, text, tint=ACCENT):
    content = [P(f'<b>{title}</b>', ParagraphStyle('ct', parent=cell, textColor=tint, fontSize=10)), P(text, cell)]
    t = Table([[content]], colWidths=[FULL])
    t.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, -1), colors.Color(tint.red, tint.green, tint.blue, alpha=0.08)),
        ('LINEBEFORE', (0, 0), (0, -1), 3, tint),
        ('LEFTPADDING', (0, 0), (-1, -1), 10), ('RIGHTPADDING', (0, 0), (-1, -1), 10),
        ('TOPPADDING', (0, 0), (-1, -1), 8), ('BOTTOMPADDING', (0, 0), (-1, -1), 8)]))
    return KeepTogether([t, Spacer(1, 9)])


def shot(name, width=FULL, note=None):
    """An app screenshot with a thin frame and an optional caption."""
    path = os.path.join(IMG, name)
    from PIL import Image as PILImage
    w, h = PILImage.open(path).size
    img = Image(path, width=width, height=width * h / w)
    frame = Table([[img]], colWidths=[width])
    frame.setStyle(TableStyle([('BOX', (0, 0), (-1, -1), 0.6, LINE), ('LEFTPADDING', (0, 0), (-1, -1), 0),
                               ('RIGHTPADDING', (0, 0), (-1, -1), 0), ('TOPPADDING', (0, 0), (-1, -1), 0),
                               ('BOTTOMPADDING', (0, 0), (-1, -1), 0)]))
    frame.hAlign = 'LEFT'
    items = [frame] + ([P(note, caption)] if note else [Spacer(1, 10)])
    return KeepTogether(items)


def side(name, width, note, flow):
    """A screenshot on the left with text beside it."""
    from PIL import Image as PILImage
    path = os.path.join(IMG, name)
    w, h = PILImage.open(path).size
    img = Image(path, width=width, height=width * h / w)
    t = Table([[[img, P(note, caption)], flow]], colWidths=[width + 6 * mm, FULL - width - 6 * mm])
    t.setStyle(TableStyle([('VALIGN', (0, 0), (-1, -1), 'TOP'), ('LEFTPADDING', (0, 0), (-1, -1), 0),
                           ('RIGHTPADDING', (0, 0), (0, 0), 6 * mm), ('TOPPADDING', (0, 0), (-1, -1), 0)]))
    return t


def numbered(items):
    """Steps with round number badges."""
    rows = []
    badge = ParagraphStyle('badge', parent=cellb, textColor=colors.white, alignment=1, fontSize=9)
    for i, (title, text) in enumerate(items, 1):
        rows.append([P(str(i), badge), [P(f'<b>{title}</b>', cell), P(text, cell)]])
    t = Table(rows, colWidths=[8 * mm, FULL - 8 * mm])
    style = [('VALIGN', (0, 0), (-1, -1), 'TOP'), ('TOPPADDING', (0, 0), (-1, -1), 4), ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
             ('LEFTPADDING', (1, 0), (1, -1), 8)]
    for r in range(len(rows)):
        style += [('BACKGROUND', (0, r), (0, r), ACCENT)]
    t.setStyle(TableStyle(style))
    return KeepTogether([t, Spacer(1, 6)])


def section(number, title, intro=None):
    """A new chapter: a page break, a kicker, the title, and a lead paragraph."""
    items = [PageBreak(), P(f'PART {number}', kicker), P(title, h1)]
    if intro:
        items.append(P(intro, lead))
    return items


class Cycle(Flowable):
    """Day, night, morning: who does what, as three panels."""
    phases = [
        ('DAYTIME', 'You plan', False, ['Quick notes or a doc', 'Roadmap, with Claude', 'Draft and readiness check', 'You approve']),
        ('OVERNIGHT', 'Nightshift works', True, ['Worker edits the copy', 'Checks run', 'Separate reviewer', 'Nightshift commits']),
        ('MORNING', 'You decide', False, ['Review the changes', 'Merge or pull request', 'Or: fix, retry, discard']),
    ]
    HEIGHT = 80 * mm

    def wrap(self, aw, ah):
        self.aw = aw
        return aw, self.HEIGHT

    def arrow(self, x1, y1, x2, y2, color=MUTED):
        c = self.canv
        c.setStrokeColor(color)
        c.setFillColor(color)
        c.line(x1, y1, x2, y2)
        a = math.atan2(y2 - y1, x2 - x1)
        p = c.beginPath()
        p.moveTo(x2, y2)
        p.lineTo(x2 - 5.5 * math.cos(a - 0.45), y2 - 5.5 * math.sin(a - 0.45))
        p.lineTo(x2 - 5.5 * math.cos(a + 0.45), y2 - 5.5 * math.sin(a + 0.45))
        p.close()
        c.drawPath(p, fill=1, stroke=0)

    def draw(self):
        c = self.canv
        gap = 9 * mm
        widths = [self.aw * 0.3, self.aw * 0.4 - 2 * gap, self.aw * 0.3]
        x = 0
        top = self.HEIGHT
        boxes = []
        for (tag, title, dark, steps), pw in zip(self.phases, widths):
            c.setFillColor(NAVY if dark else LIGHT)
            c.setStrokeColor(NAVY if dark else LINE)
            c.roundRect(x, 0, pw, top, 7, stroke=1, fill=1)
            c.setFillColor(AMBER if dark else ACCENT)
            c.setFont('Helvetica-Bold', 7.5)
            c.drawString(x + 9, top - 15, tag)
            c.setFillColor(colors.white if dark else NAVY)
            c.setFont('Helvetica-Bold', 12)
            c.drawString(x + 9, top - 30, title)
            bh, bgap = 10 * mm, 4.2 * mm
            by = top - 42 - bh
            inner = pw - 18
            if dark:
                inner -= 12  # room for the loop line
            for i, step in enumerate(steps):
                highlight = step in ('You approve', 'Merge or pull request')
                faint = step.startswith('Or:')
                c.setFillColor(AMBER if highlight else (colors.HexColor('#2C3858') if dark else colors.white))
                c.setStrokeColor(AMBER if highlight else (colors.HexColor('#3E4B70') if dark else LINE))
                c.roundRect(x + 9, by, inner, bh, 4, stroke=1, fill=1)
                c.setFillColor(NAVY if highlight else (colors.white if dark else (MUTED if faint else INK)))
                c.setFont('Helvetica-Bold' if highlight else 'Helvetica', 8.8)
                c.drawCentredString(x + 9 + inner / 2, by + bh / 2 - 3, step)
                if i < len(steps) - 1 and not steps[i + 1].startswith('Or:'):
                    self.arrow(x + 9 + inner / 2, by - 0.5, x + 9 + inner / 2, by - bgap + 1, colors.HexColor('#8F9BC4') if dark else MUTED)
                boxes.append((x, by, inner))
                by -= bh + bgap
            if dark:
                # Next task: from the last box back up to the first, along the right edge.
                first_y = top - 42 - bh / 2
                last_y = by + bh + bgap + bh / 2
                rx = x + 9 + inner + 7
                c.setStrokeColor(AMBER)
                c.setDash(2, 2)
                c.line(x + 9 + inner, last_y, rx, last_y)
                c.line(rx, last_y, rx, first_y)
                c.setDash()
                self.arrow(rx, first_y, x + 9 + inner + 1, first_y, AMBER)
                c.saveState()
                c.translate(rx + 4, (first_y + last_y) / 2)
                c.rotate(90)
                c.setFillColor(AMBER)
                c.setFont('Helvetica-Oblique', 7)
                c.drawCentredString(0, -6, 'next task, until all are done')
                c.restoreState()
            x += pw + gap
        # Between the panels.
        mid = top / 2
        self.arrow(widths[0] + 1.5, mid, widths[0] + gap - 1.5, mid, ACCENT)
        self.arrow(widths[0] + gap + widths[1] + 1.5, mid, widths[0] + gap + widths[1] + gap - 1.5, mid, ACCENT)


def cover(c, doc):
    c.saveState()
    c.setFillColor(NAVY)
    c.rect(0, 0, W, H, stroke=0, fill=1)
    cx, cy, r = W - 60 * mm, H - 72 * mm, 27 * mm
    c.setFillColor(AMBER)
    c.circle(cx, cy, r, stroke=0, fill=1)
    c.setFillColor(NAVY)
    c.circle(cx + 11 * mm, cy + 7 * mm, r * 0.92, stroke=0, fill=1)
    c.setFillColor(colors.HexColor('#8F9BC4'))
    for sx, sy, sr in [(40, 250, 1.4), (70, 268, 1), (120, 238, 1.2), (150, 262, 0.8), (35, 210, 0.9), (95, 220, 1.1), (60, 190, 0.7)]:
        c.circle(sx * mm, sy * mm, sr, stroke=0, fill=1)
    c.setFillColor(colors.white)
    c.setFont('Helvetica-Bold', 46)
    c.drawString(MARGIN, 152 * mm, 'Nightshift')
    c.setFont('Helvetica', 18)
    c.setFillColor(colors.HexColor('#D7DCEE'))
    c.drawString(MARGIN, 139 * mm, 'User guide')
    c.setFont('Helvetica', 12.5)
    c.setFillColor(colors.HexColor('#B8C0DD'))
    y = 121 * mm
    for line in ['Plan the work with Claude during the day. Nightshift does it overnight,',
                 'in its own copy of the project, checking and reviewing every change.',
                 'In the morning you look it over and decide what goes in.']:
        c.drawString(MARGIN, y, line)
        y -= 7 * mm
    c.setStrokeColor(AMBER)
    c.setLineWidth(2)
    c.line(MARGIN, 92 * mm, MARGIN + 30 * mm, 92 * mm)
    c.setFont('Helvetica', 10)
    c.setFillColor(colors.HexColor('#B8C0DD'))
    c.drawString(MARGIN, 80 * mm, 'Version 0.6  •  October 2026')
    c.drawString(MARGIN, 73 * mm, 'App: ~/CodexProjects/nightshift/app/build/Nightshift.app')
    c.drawString(MARGIN, 66 * mm, 'Repository: ~/CodexProjects/nightshift  •  github.com/omsomso/nightshift (private)')
    c.restoreState()


def page(c, doc):
    c.saveState()
    c.setFont('Helvetica', 8)
    c.setFillColor(MUTED)
    c.drawString(MARGIN, 11 * mm, 'Nightshift user guide')
    c.drawRightString(W - MARGIN, 11 * mm, str(doc.page))
    c.setStrokeColor(LINE)
    c.setLineWidth(0.5)
    c.line(MARGIN, 14 * mm, W - MARGIN, 14 * mm)
    c.restoreState()


doc = BaseDocTemplate(OUT, pagesize=A4, leftMargin=MARGIN, rightMargin=MARGIN, topMargin=18 * mm, bottomMargin=20 * mm,
                      title='Nightshift user guide', author='Nightshift', subject='How to plan, run, and approve work with Nightshift')
frame = Frame(MARGIN, 20 * mm, FULL, H - 38 * mm, id='f')
doc.addPageTemplates([PageTemplate(id='cover', frames=[frame], onPage=cover),
                      PageTemplate(id='page', frames=[frame], onPage=page)])
s = [NextPageTemplate('page'), PageBreak()]

# ── Overview ───────────────────────────────────────────────────────────────────
s += [P('OVERVIEW', kicker), P('Nightshift in one page', h1),
      P('Nightshift runs a coding plan while you are away. You decide what should be done; agents do the work in a private '
        'copy of the project; Nightshift checks and reviews every change, keeps only what passes, and stops when something '
        'needs you. Nothing reaches your real branch until you approve it.', lead),
      Cycle(), Spacer(1, 12),
      P('You are needed three times', h2),
      table([['When', 'What you do', 'Where'],
             ['Before it runs', 'Approve the drafted plan (after a readiness check, and edits if you want).', 'Plan view: Approve and Start'],
             ['If it gets stuck', 'Read why, then retry, skip, or fix it yourself with Claude.', 'Plan view: Needs you'],
             ['When it is done', 'Review the changes, then merge them or open a pull request.', 'Plan view: Review Changes'],
             ], [32 * mm, FULL - 82 * mm, 50 * mm], bold_first=True),
      P('What it promises', h2),
      *bullets([
          '<b>Your checkout is never touched.</b> Each plan works in its own git worktree on its own branch.',
          '<b>It starts from a good place.</b> By default the project\'s main branch as it is on GitHub, fetched first, not '
          'whatever happens to be checked out.',
          '<b>Agents are fenced in.</b> They can only write inside the plan\'s copy and cannot reach the network or change git history.',
          '<b>Nothing is pushed without you.</b> Merges are local; a pull request is opened only when you choose it.',
          '<b>Subscription only.</b> It runs on your claude.ai (and ChatGPT) sign-in and refuses pay-per-token setups.',
      ])]

# ── Part 1: Set up ─────────────────────────────────────────────────────────────
s += section(1, 'Set up once', 'A few minutes, once. After that you mostly use the app.')
s += [numbered([
          ('Install the command', 'In Terminal, from the Nightshift folder, run ' + m('node src/cli.js setup') + '. It records the '
           'installed Claude (and Codex) versions, checks that you are signed in with a subscription, and installs the '
           + m('nightshift') + ' command and the Nightshift skill for Claude and Codex chats. It needs Node 22.13 or newer.'),
          ('Open the app', 'Build it with ' + m('app/build.sh') + ' and open ' + m('app/build/Nightshift.app') + ' (copy it to '
           'Applications if you like). The moon in the menu bar shows your plans and fills in when one needs you.'),
          ('Check your accounts', 'Settings (Cmd-comma) › Accounts shows each provider, its version and sign-in, and an on/off switch. '
           'Codex is off for now to save its usage; Claude then does both the work and the review, in separate conversations.'),
          ('Choose how runs behave', 'Settings › Runs, shown below. The defaults are safe; the one you may want to turn on is '
           '"Start runners again when I log in".'),
      ]),
      shot('settings-runs.png', 92 * mm, 'Settings › Runs. Every option here is also a command (nightshift settings, nightshift autostart).'),
      ]

# ── Part 2: Plan the work ──────────────────────────────────────────────────────
s += section(2, 'Plan the work', 'Turn rough notes into a plan Nightshift can run. There are three ways in; they all end in the '
             'same place: a draft waiting for your approval.')
s += [P('A. In the app: Plan Studio', h2),
      P('Press <b>+</b> (New Plan), paste your notes as they are, and press <b>Start Interview</b>. Claude reads your workspace, '
        'works out which project the notes are about, reads its code and rules (it cannot change anything), and asks what '
        'the code cannot answer, one question at a time. Then it writes the roadmap on the right.'),
      shot('studio.png', FULL, 'Plan Studio: questions on the left (each choice explained, one marked Recommended; press 1 to 9 to pick), '
           'the roadmap on the right with its revision and when it last changed.'),
      *bullets([
          '<b>Stop</b> (Cmd-period) ends Claude\'s turn at once; reply to carry on.',
          '<b>Starts from</b> shows where the plan will begin (by default the latest main branch on GitHub). Change it if the '
          'work builds on another branch. A warning icon means some work would be left out, for example commits you have not pushed.',
          '<b>Edit the roadmap freely.</b> Your edits go to Claude with your next message, so its next version builds on them. '
          '<b>Restore Previous</b> undoes the last change.',
          '<b>Save and Draft Plan</b> writes the roadmap into the project and drafts the plan.',
      ]),
      CondPageBreak(70 * mm),
      P('B. From a Claude or Codex chat', h2),
      P('Ask any Claude Code or Codex session to "use Nightshift" for some work. The Nightshift skill tells it what to do: '
        '<b>prepare</b> the project (merge what the plan needs, fix a broken build, with your agreement), <b>check</b> it with '
        + m('nightshift check --repo PATH') + ', <b>draft</b> the plan, show it to you, and start it only when you say so. '
        'This is the best way in when the project needs some work before Nightshift can start.'),
      P('C. From the terminal', h2),
      code('''nightshift draft docs/plans/meter.md          # draft only; prints the plan
nightshift draft docs/ROADMAP.md --steps "1-5"  # only some steps
nightshift draft docs/ROADMAP.md --base main    # start from the local main
nightshift run docs/ROADMAP.md                  # draft, ask once, then run'''),
      callout('Where a plan starts', 'Nightshift fetches GitHub and starts from the project\'s main branch as it is there, so work '
              'merged from other sessions is included and your checkout does not matter. Unpushed commits, unmerged branches, and '
              'uncommitted changes are not included; the draft lists anything it leaves out. Use ' + m('--base') + ' (or Starts from) '
              'to pick another branch.', ACCENT)]

# ── Part 3: Approve ────────────────────────────────────────────────────────────
s += section(3, 'Look it over and approve', 'A draft does nothing until you approve it. The coloured panel at the top of '
             'every plan always shows what the plan needs from you now, with the buttons for it.')
s += [shot('app-draft.png', FULL, 'A draft. The sidebar lists every plan and the queue; the panel holds the main buttons.'),
      table([['Button', 'What it does'],
             ['Approve and Start', 'Creates the plan\'s private copy and branch and runs it in the background.'],
             ['Check Readiness', 'Runs the plan\'s checks now, at the exact commit it will start from. A broken build shows up here, '
              'not halfway through the night.'],
             ['Edit', 'Reword, reorder, remove, or add tasks; change the checks and the folders the work may touch.'],
             ['Add to Queue', 'Runs the plan after the ones before it, for example overnight. Start the queue from the sidebar.'],
             ['Works / Reviews', 'Which agent does the work and which reviews it. With Codex off, Claude does both.'],
             ], [36 * mm, FULL - 36 * mm], bold_first=True),
      side('edit.png', 88 * mm, 'Edit: tasks, checks, and allowed folders.', [
          P('Editing a draft', h2),
          P('<b>Edit</b> opens the whole plan: reword a task or its "done when", move tasks up and down, remove one, or add your '
            'own. The checks are one command per line; the allowed folders limit what the work may touch.'),
          P('Each task has a <b>difficulty</b> (low, medium, high) chosen by the planner. It sets how much effort the worker starts '
            'with, and every retry goes one level higher. Change it if you disagree.'),
          P('Nothing runs until you press Approve and Start.', small)])]

# ── Part 4: Overnight ──────────────────────────────────────────────────────────
s += section(4, 'While it runs', 'Close the laptop lid if you like; Nightshift keeps going until the plan is done or needs you.')
s += [P('What happens for each task', h2),
      numbered([
          ('The worker edits', 'An agent changes the plan\'s copy, fenced in by the operating system.'),
          ('Nightshift checks it', 'It runs the project\'s checks itself, in a sandbox, plus its safety gates: allowed folders only, '
           'no protected files, not too big, not the same failure again.'),
          ('A separate reviewer judges it', 'A fresh conversation compares the change with the task\'s "done when". If it is not '
           'right, the worker tries again with the reasons.'),
          ('Nightshift commits it', 'Only accepted changes are committed. After the last task come the full checks and a final '
           'review of the whole plan (with one fix-up round if needed).'),
      ]),
      P('<b>Following along.</b> Running plans show an <b>Activity</b> card: files read and edited, commands, checks, reviews, and '
        'commits as they happen. The menu bar moon fills in, with a notification, when a plan needs you.'),
      P('Usage limits', h2),
      P('If your subscription\'s usage limit is reached, the plan waits for the reset and then carries on by itself; the '
        'interrupted attempt does not count against the task. <b>Try Now</b> continues early.'),
      shot('panel-waiting.png', FULL, 'A plan waiting for the usage limit to reset.'),
      P('Queue and restarts', h2),
      P('Plans in the <b>queue</b> run one after another: when the running plan stops for you (ready, blocked, or paused), the next '
        'one starts. A usage-limit wait does not count, because the next plan would hit the same limit. With <b>Start runners again '
        'when I log in</b> on, a restart of the Mac does not end the night; runners you stopped yourself stay stopped.'),
      table([['Control', 'What it does'],
             ['Pause / Resume', 'Pause before the next task starts; resume when you are ready.'],
             ['Stop Turn', 'Stop the agent\'s current turn now. Its task stops for you and the plan pauses.'],
             ['Stop Runner', 'Stop the background runner after its current step. Start Runner continues where it left off.'],
             ], [36 * mm, FULL - 36 * mm], bold_first=True)]

# ── Part 5: When it needs you ──────────────────────────────────────────────────
s += section(5, 'When it needs you', 'A blocked plan is Nightshift doing its job: it stopped instead of guessing. The red panel '
             'says why, with the check output.')
s += [shot('panel-blocked.png', FULL, 'A blocked plan. Below the panel, Activity shows how it got there.'),
      table([['Button', 'Use it when'],
             ['Retry', 'You have fixed the cause (or it was temporary). The task runs again and the plan resumes.'],
             ['Fix with Claude', 'You want to sort it out together. Opens Claude in Terminal, in the plan\'s copy of the project, '
              'already told what went wrong (the same text is on your clipboard). Claude fixes it with you but does not commit.'],
             ['Accept Fix', 'After fixing it yourself or with Claude: Nightshift runs the checks on what is in the copy now and, '
              'if they pass, commits it as the task and continues.'],
             ['More › Skip This Task', 'The task is not needed after all (for example a check-only step).'],
             ], [36 * mm, FULL - 36 * mm], bold_first=True),
      CondPageBreak(95 * mm),
      P('Common reasons', h2),
      table([['The panel says', 'What it means', 'What to do'],
             ['The checks fail before any change', 'The project is already broken where the plan starts.',
              'Fix it on the main branch (a Claude chat is good for this), then Retry.'],
             ['Stagnation', 'The same change failed the same way twice, or nothing changed.', 'Read the check output; Fix with Claude, or Retry with a clearer task.'],
             ['Drift', 'A file outside the plan\'s folders, or a protected file, was changed.', 'Edit the allowed folders if it was right, or Retry.'],
             ['Attempt limit reached', 'The task failed three times.', 'Usually a task that is too big or unclear: fix it yourself, or Skip.'],
             ['Final review failed', 'The whole plan does not meet its brief, even after a fix-up.', 'Review the changes; Fix with Claude, then Retry.'],
             ['Billing', 'A sign-in or setting would have charged per token.', 'Fix the sign-in in Settings › Accounts, then Retry.'],
             ], [42 * mm, 62 * mm, FULL - 104 * mm], bold_first=True)]

# ── Part 6: Morning ────────────────────────────────────────────────────────────
s += section(6, 'In the morning', 'A finished plan waits on its branch. Look at what it did, then decide.')
s += [shot('panel-ready.png', FULL, 'Ready to merge: the final review\'s verdict, Review Changes, and Approve.'),
      P('<b>Review Changes</b> opens every task\'s change side by side with the reviewer\'s verdict and the checks, plus the whole '
        'plan\'s change at the top. You can approve from there.'),
      shot('review.png', 150 * mm, 'Review: the whole plan or one task at a time, with colored diffs.'),
      P('Approving', h2),
      table([['Choice', 'What happens'],
             ['Merge on this Mac', 'The plan\'s branch is merged into the branch it started from (for example main), wherever that '
              'is checked out. Nothing is pushed; push yourself when you are ready.'],
             ['Open a pull request', 'Nightshift pushes only the plan\'s branch and opens a pull request into the starting branch with '
              'the GitHub CLI. Merge it on GitHub as usual.'],
             ], [40 * mm, FULL - 40 * mm], bold_first=True),
      P('The Approve button uses your default from Settings › Runs; its arrow offers the other way. Either way you confirm first. '
        'Afterwards, <b>Remove</b> (in the round ... menu at the top right) clears the plan from the list; a plan you do not want can be deleted the same '
        'way, along with its branch.')]

# ── Part 7: Safety ─────────────────────────────────────────────────────────────
s += section(7, 'Safety and limits', 'The fences are enforced by the operating system and by Nightshift\'s own code, not by '
             'asking the agents nicely. They were tested with agents asked to break them.')
s += [table([['Agents can', 'Agents cannot'],
             ['Read the project and edit files in the plan\'s copy.', 'Write anywhere else (apart from temporary folders).'],
             ['Run what their task needs: builds, tests, scripts.', 'Reach the network: no web, no installs, no pushing.'],
             ['See the results of the checks Nightshift runs.', 'Commit, push, rebase, or otherwise change git history.'],
             ['', 'Read your SSH keys, cloud credentials, GitHub login, or keychain.'],
             ['', 'Change protected files: AGENTS.md, CLAUDE.md, .github/, .claude/, .codex/.'],
             ['', 'Add tasks, change limits, or approve their own work.']],
            [FULL / 2, FULL / 2]),
      P('<b>Your checks are fenced too.</b> Nightshift runs the project\'s tests and builds in a macOS sandbox: they may write '
        'only inside the plan\'s copy, temporary folders, and tool caches, with no network. A build step that tries to write into '
        'your own checkout fails, with a note saying the sandbox stopped it. You can relax this in Settings › Runs.'),
      P('<b>Project rules travel with the plan.</b> Nightshift gives every agent the project\'s AGENTS.md and CLAUDE.md. Where they '
        'ask for something Nightshift forbids (commit, push, install), Nightshift wins and the step is left for you.'),
      P('<b>Billing.</b> Only subscription sign-ins are used; API keys are stripped, a pay-per-token sign-in is refused, and a turn '
        'that reports one stops the plan. For extra safety keep Usage credits off (or capped) in claude.ai.'),
      P('Kill switches', h2),
      table([['Limit', 'Default', 'When reached'],
             ['Attempts per task', '3', 'The task stops for you.'],
             ['Time per agent turn', '20 minutes', 'The turn is stopped; the task stops for you.'],
             ['Attempts per plan', '3 per task + 2', 'The plan pauses.'],
             ['Tokens per plan', '5 million', 'The plan pauses.'],
             ['Time per plan', '6 hours', 'The plan pauses.'],
             ['Changed lines per task', '800', 'The worker is asked for a smaller change.'],
             ['Time per check', '10 minutes', 'The check fails.'],
             ['Fix-up rounds at the end', '1', 'The plan stops for you.']],
            [60 * mm, 32 * mm, FULL - 92 * mm], bold_first=True),
      P('Raise a limit on a running plan with ' + m('nightshift limit tokens 8000000 --plan ID') + ', then resume.', small)]

# ── Part 8: Settings and usage ─────────────────────────────────────────────────
s += section(8, 'Settings and usage')
s += [table([['Tab', 'What is there'],
             ['Accounts', 'Providers, versions, sign-in (a Sign In button opens your browser; subscription only), on/off, Run Setup, '
              'and effort bounds for workers, reviewers, and the planner.'],
             ['Runs', 'Usage limits (wait or stop), sandboxed checks and their network access, how you approve (merge or pull '
              'request), and restarting runners at login.'],
             ['Usage', 'Tokens and turns per day and per plan. Plans run on your subscriptions; Claude also reports what the same '
              'turns would cost at API prices, which you are not charged.'],
             ], [28 * mm, FULL - 28 * mm], bold_first=True),
      shot('settings-usage.png', 82 * mm, 'Settings › Usage.')]

# ── Part 9: Troubleshooting ────────────────────────────────────────────────────
s += section(9, 'Troubleshooting')
s += [table([['Problem', 'What to do'],
             ['The app says Nightshift is not set up', 'Run ' + m('node src/cli.js setup') + ' once from the Nightshift folder, then reopen the app.'],
             ['A plan did not see recent work', 'It starts from the main branch on GitHub. Push or merge the work first, or pick another '
              'branch with Starts from (' + m('--base') + '). The draft lists what it left out.'],
             ['Checks fail in the sandbox but pass in Terminal', 'The output says what the sandbox stopped: usually a write outside the '
              'project or a download. Change the build step if you can; otherwise relax the sandbox in Settings › Runs.'],
             ['Merge refuses', 'The checkout that has the target branch (usually main) has uncommitted changes. Commit or stash them, then approve again.'],
             ['Pull request refuses', 'Install the GitHub CLI and run ' + m('gh auth login') + '; the project needs a GitHub remote.'],
             ['The Mac restarted', 'Turn on "Start runners again when I log in", or run ' + m('nightshift resume-runners') + '.'],
             ['A plan waits for a long time', 'It is waiting for the usage limit to reset; the panel says until when. Try Now continues early.'],
             ['The app will not build', 'Use ' + m('app/build.sh') + '; it uses Xcode\'s toolchain.'],
             ], [52 * mm, FULL - 52 * mm], bold_first=True)]

# ── Part 10: Command reference ─────────────────────────────────────────────────
s += section(10, 'Command reference', 'Everything in the app is also a command. ' + m('nightshift --help') + ' lists them all.')
s += [code('''# set up
nightshift setup                       # once, and after updating Claude or Codex
nightshift settings                    # run options; settings set KEY VALUE
nightshift autostart on                # restart runners at login

# plan
nightshift check --repo PATH           # is the project ready? what would be left out?
nightshift draft DOC                   # --steps "1-5", --base BRANCH
nightshift edit ID --file FILE.json    # change a draft
nightshift check --plan ID             # a draft's own checks at its start
nightshift start ID                    # approve and run
nightshift queue add ID                # and: queue start | up | down | remove

# follow and steer
nightshift list                        # all plans
nightshift activity ID                 # what the agents just did
nightshift pause --plan ID             # and: resume --plan ID
nightshift interrupt --plan ID         # stop the running turn now
nightshift stop ID                     # stop the runner; start ID continues

# when it needs you
nightshift report --plan ID            # why it stopped, with the check output
nightshift retry TASK --plan ID        # then: resume --plan ID
nightshift fix-prompt ID               # context for fixing it with Claude
nightshift accept TASK --plan ID       # take your fix
nightshift skip TASK --plan ID

# finish
nightshift review ID                   # each task's change, verdict, and checks
nightshift merge ID                    # merge locally (nothing is pushed)
nightshift merge ID --pr               # or: push the branch and open a pull request
nightshift discard ID --yes            # delete a plan
nightshift usage                       # tokens per day and per plan'''),
      callout('One more thing', 'You do not have to watch it. Start a plan in the evening and go do something else. In the morning, '
              'the app tells you which plans are ready and which need you.', GREEN)]

doc.build(s)
print(f'wrote {OUT}')
