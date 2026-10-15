"""Builds the Nightshift user guide PDF with ReportLab."""
import sys
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_LEFT
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (BaseDocTemplate, PageTemplate, Frame, Paragraph, Spacer, Table, TableStyle,
                                Preformatted, PageBreak, KeepTogether, Flowable, NextPageTemplate, CondPageBreak)

OUT = sys.argv[1]
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

W, H = A4
MARGIN = 20 * mm

body = ParagraphStyle('body', fontName='Helvetica', fontSize=10.3, leading=15, textColor=INK, spaceAfter=6)
small = ParagraphStyle('small', parent=body, fontSize=8.8, leading=12, textColor=MUTED)
lead = ParagraphStyle('lead', parent=body, fontSize=12, leading=18, textColor=INK, spaceAfter=10)
h1 = ParagraphStyle('h1', fontName='Helvetica-Bold', fontSize=20, leading=25, textColor=NAVY, spaceBefore=4, spaceAfter=10)
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


def code(text):
    """A shaded command block."""
    block = Preformatted(text.strip('\n'), codestyle)
    t = Table([[block]], colWidths=[W - 2 * MARGIN])
    t.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, -1), LIGHT), ('BOX', (0, 0), (-1, -1), 0.6, LINE),
        ('LEFTPADDING', (0, 0), (-1, -1), 9), ('RIGHTPADDING', (0, 0), (-1, -1), 9),
        ('TOPPADDING', (0, 0), (-1, -1), 7), ('BOTTOMPADDING', (0, 0), (-1, -1), 7)]))
    return KeepTogether([t, Spacer(1, 7)])


def m(text):
    """Inline monospace."""
    return f'<font name="Mono" size="8.8" color="#1B2540">{text}</font>'


def table(rows, widths, header=True, mono_first=False):
    data = []
    for i, row in enumerate(rows):
        styled = []
        for j, value in enumerate(row):
            if header and i == 0:
                styled.append(P(value, ParagraphStyle('th', parent=cellb, textColor=colors.white)))
            elif mono_first and j == 0:
                styled.append(P(value, cellmono))
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
    t = Table([[content]], colWidths=[W - 2 * MARGIN])
    t.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, -1), colors.Color(tint.red, tint.green, tint.blue, alpha=0.08)),
        ('LINEBEFORE', (0, 0), (0, -1), 3, tint),
        ('LEFTPADDING', (0, 0), (-1, -1), 10), ('RIGHTPADDING', (0, 0), (-1, -1), 10),
        ('TOPPADDING', (0, 0), (-1, -1), 8), ('BOTTOMPADDING', (0, 0), (-1, -1), 8)]))
    return KeepTogether([t, Spacer(1, 9)])


class Flow(Flowable):
    """The plan lifecycle as two rows of boxes joined by arrows."""
    steps = [('Your document', 'steps in docs/'), ('Draft plan', 'agent proposes tasks'), ('You approve', 'once, up front'),
             ('Worker edits', 'sandboxed worktree'), ('Checks + gates', 'run by Nightshift'), ('Reviewer', 'separate conversation'),
             ('Commit', 'by Nightshift'), ('Final review', 'whole plan'), ('You merge', 'the only approval')]

    def wrap(self, aw, ah):
        self.aw = aw
        return aw, 128

    def draw(self):
        c = self.canv
        per_row = 5
        gap = 9 * mm
        bw = (self.aw - gap * (per_row - 1)) / per_row
        bh = 15 * mm
        rows_y = [128 - bh - 4, 128 - 2 * bh - 30]
        positions = []
        for i, (title, sub) in enumerate(self.steps):
            row = 0 if i < per_row else 1
            col = i if row == 0 else (per_row - 1) - (i - per_row)  # second row runs right to left
            x = col * (bw + gap)
            y = rows_y[row]
            positions.append((x, y))
            highlight = title in ('You approve', 'You merge')
            c.setFillColor(AMBER if highlight else (NAVY if i in (3, 4, 5, 6) else LIGHT))
            c.setStrokeColor(AMBER if highlight else (NAVY if i in (3, 4, 5, 6) else LINE))
            c.roundRect(x, y, bw, bh, 5, stroke=1, fill=1)
            dark = i in (3, 4, 5, 6)
            c.setFillColor(colors.white if dark else NAVY)
            c.setFont('Helvetica-Bold', 8.6)
            c.drawCentredString(x + bw / 2, y + bh - 17, title)
            c.setFont('Helvetica', 7.2)
            c.setFillColor(colors.HexColor('#C9D0E6') if dark else MUTED)
            c.drawCentredString(x + bw / 2, y + 9, sub)
        c.setStrokeColor(MUTED)
        c.setFillColor(MUTED)
        c.setLineWidth(1.1)

        def arrow(x1, y1, x2, y2):
            c.line(x1, y1, x2, y2)
            import math
            a = math.atan2(y2 - y1, x2 - x1)
            p = c.beginPath()
            p.moveTo(x2, y2)
            p.lineTo(x2 - 6 * math.cos(a - 0.4), y2 - 6 * math.sin(a - 0.4))
            p.lineTo(x2 - 6 * math.cos(a + 0.4), y2 - 6 * math.sin(a + 0.4))
            p.close()
            c.drawPath(p, fill=1, stroke=0)

        for i in range(len(self.steps) - 1):
            (x1, y1), (x2, y2) = positions[i], positions[i + 1]
            if i == per_row - 1:  # turn down to the second row
                arrow(x1 + bw / 2, y1, x2 + bw / 2, y2 + bh)
            elif i < per_row - 1:
                arrow(x1 + bw, y1 + bh / 2, x2, y2 + bh / 2)
            else:
                arrow(x1, y1 + bh / 2, x2 + bw, y2 + bh / 2)
        # Repair loop: from the Reviewer (below, right) back up to Worker edits (above), through the gap
        # between the rows, clear of the Checks-to-Reviewer arrow.
        rx, ry = positions[5]
        wx, wy = positions[3]
        mid = (ry + bh + wy) / 2
        start_x = rx + bw * 0.22
        c.setDash(2, 2)
        c.setStrokeColor(RED)
        c.setFillColor(RED)
        c.line(start_x, ry + bh, start_x, mid)
        c.line(start_x, mid, wx + bw / 2, mid)
        arrow(wx + bw / 2, mid, wx + bw / 2, wy - 1)
        c.setDash()
        c.setFont('Helvetica-Oblique', 7.2)
        c.drawString(wx + bw / 2 + 5, mid + 3, 'not accepted: repair')


def cover(c, doc):
    c.saveState()
    c.setFillColor(NAVY)
    c.rect(0, 0, W, H, stroke=0, fill=1)
    # A crescent moon: an amber disc with a navy disc over it.
    cx, cy, r = W - 62 * mm, H - 70 * mm, 26 * mm
    c.setFillColor(AMBER)
    c.circle(cx, cy, r, stroke=0, fill=1)
    c.setFillColor(NAVY)
    c.circle(cx + 11 * mm, cy + 7 * mm, r * 0.92, stroke=0, fill=1)
    c.setFillColor(colors.HexColor('#8F9BC4'))
    for sx, sy, sr in [(40, 250, 1.4), (70, 268, 1), (120, 238, 1.2), (150, 262, 0.8), (35, 210, 0.9), (95, 220, 1.1)]:
        c.circle(sx * mm, sy * mm, sr, stroke=0, fill=1)
    c.setFillColor(colors.white)
    c.setFont('Helvetica-Bold', 44)
    c.drawString(MARGIN, 150 * mm, 'Nightshift')
    c.setFont('Helvetica', 17)
    c.setFillColor(colors.HexColor('#D7DCEE'))
    c.drawString(MARGIN, 138 * mm, 'User guide')
    c.setFont('Helvetica', 12.5)
    c.setFillColor(colors.HexColor('#B8C0DD'))
    y = 120 * mm
    for line in ['Hand Nightshift the steps from your docs. It works through them',
                 'in its own copy of your repository, checks and reviews every change,',
                 'and leaves a branch that waits for you to merge.']:
        c.drawString(MARGIN, y, line)
        y -= 7 * mm
    c.setStrokeColor(AMBER)
    c.setLineWidth(2)
    c.line(MARGIN, 92 * mm, MARGIN + 30 * mm, 92 * mm)
    c.setFont('Helvetica', 10)
    c.setFillColor(colors.HexColor('#B8C0DD'))
    c.drawString(MARGIN, 80 * mm, 'Version 0.5  •  October 2026')
    c.drawString(MARGIN, 73 * mm, 'Repository: ~/CodexProjects/nightshift  •  github.com/omsomso/nightshift (private)')
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
                      title='Nightshift user guide', author='Nightshift', subject='How to set up and use Nightshift')
frame = Frame(MARGIN, 20 * mm, W - 2 * MARGIN, H - 38 * mm, id='f')
doc.addPageTemplates([PageTemplate(id='cover', frames=[frame], onPage=cover),
                      PageTemplate(id='page', frames=[frame], onPage=page)])
FULL = W - 2 * MARGIN
s = [NextPageTemplate('page'), PageBreak()]

# 1 — What it is
s += [P('What Nightshift does', h1),
      P('Nightshift runs a coding plan for you while you are away. You point it at the steps in a document, approve '
        'the plan once, and it works through the steps one by one. Every change is checked and reviewed before it is '
        'kept, and nothing reaches your real branch until you merge it yourself.', lead),
      Flow(), Spacer(1, 6),
      P('<b>How one task goes.</b> The worker agent edits files in a private copy of your repository (a git worktree) '
        'inside a sandbox. Nightshift then runs your checks (for example ' + m('npm test') + ') and its own safety gates. '
        'A separate reviewer, in a different conversation, judges the change. If it is accepted, Nightshift commits it; '
        'if not, the worker gets the reason and tries again, up to a limit.'),
      P('<b>When it is a good fit.</b> Long or overnight plans, risky changes, or several plans at once: anywhere you '
        'would rather not babysit an agent, and want a second opinion and hard limits. For a short plan you will look at '
        'within the hour, a normal Claude session is faster; see the comparison in ' + m('docs/COMPARISON.md') + '.'),
      callout('You stay in control', 'Nightshift never pushes, never merges on its own, and never edits your checked-out '
              'branch. It cannot spend money on API keys: it only runs on your Claude subscription (and ChatGPT, if Codex '
              'is turned on). Merging the finished branch is your approval.', AMBER)]

# 2 — Setup
s += [CondPageBreak(90 * mm), P('One-time setup', h1),
      P('You need Node.js 22.13 or newer (installed with Homebrew on this Mac) and the Claude CLI signed in with your '
        'claude.ai account. Codex is optional and currently turned off.'),
      code('''cd ~/CodexProjects/nightshift
node src/cli.js setup     # first time only; afterwards: nightshift setup'''),
      P(m('setup') + ' records the exact Claude version and checks that it is signed in with a subscription. Run it again '
        'after you update the Claude CLI (' + m('nightshift setup') + ' from then on); until then Nightshift refuses to start, so '
        'an update never surprises a running plan.'),
      P('It also installs two things for your user account:'),
      *bullets(['<b>The ' + m('nightshift') + ' command</b> (in ' + m('~/.local/bin') + '), so you can type ' + m('nightshift')
                + ' in any folder. The rest of this guide uses it.',
                '<b>A Nightshift skill</b> for Claude Code and Codex, so any session in any project knows how to hand work to '
                'Nightshift. Try telling one: "use Nightshift to implement steps 1-5 of docs/ROADMAP.md". It drafts the plan, '
                'shows it to you, and starts it only when you say so.'])]

# 3 — Running a plan
s += [PageBreak(), P('Run a plan from your docs', h1),
      P('There are three ways in, all ending in the same plan:'),
      *bullets(['<b>The app:</b> New Plan opens Plan Studio. Paste your quick notes; Claude works out the project, asks you a few '
                'multiple-choice questions, and writes the roadmap (see The Nightshift app).',
                '<b>Any Claude or Codex session:</b> "use Nightshift to implement steps 1-5 of docs/ROADMAP.md".',
                '<b>The terminal</b>, with the steps in a document you already have:']),
      code('''nightshift run ~/CodexProjects/my-project/docs/ROADMAP.md --steps "1-10"'''),
      P('What happens:'),
      *bullets([
          '<b>Drafting (about a minute).</b> A read-only agent reads the document and the project\'s own agent rules '
          '(AGENTS.md, CLAUDE.md) and proposes a plan: one task per step, in order, each with "done when" criteria, the '
          'check commands to run, and the folders the work may touch. It does not invent, merge, or reorder steps.',
          '<b>You approve once.</b> Nightshift prints the plan and asks ' + m('Start this plan now? [y/N]') + '. Answer '
          + m('y') + ' and it starts in the background; anything else keeps it as a draft.',
          '<b>It runs on its own</b> until every task and the final review pass, or until something needs you. You can '
          'close the terminal; the plan keeps going (it does not survive a restart of the Mac, see Troubleshooting).',
      ]),
      P('Useful options', h2),
      table([['Option', 'What it does'],
             ['--steps "..."', 'Which steps to plan: "1-10", "the M2 section", "everything not done yet". Omit for all open steps.'],
             ['--request "..."', 'Extra guidance for the planner, for example "keep changes small".'],
             ['--agents claude', 'Who works and who reviews. With Codex off, Claude does both, in separate conversations.'],
             ['--base v1.2', 'Start from another branch, tag, or commit. By default a plan starts from the project\'s main branch, freshly fetched from its remote, whatever is checked out.'],
             ['--yes', 'Skip the confirmation question (for scripts).']], [38 * mm, FULL - 38 * mm], mono_first=True),
      P('Before you start', h2),
      *bullets([
          '<b>Checks must pass today.</b> Nightshift runs them after every task; if they already fail, every task will.',
          '<b>Install dependencies first.</b> Agents have no network, so they cannot install packages.',
          '<b>Merge the work it needs.</b> The plan starts from the latest main branch on the remote; unmerged branches and uncommitted changes are not included.',
          '<b>Draft without starting:</b> ' + m('nightshift draft &lt;doc&gt;') + ', look it over, then '
          + m('nightshift start &lt;id&gt;') + '.',
      ])]

# 4 — Following and controlling
s += [PageBreak(), P('Follow and control a plan', h1),
      P('Each plan has an id (shown when it starts, and by ' + m('list') + '). Plans live in '
        + m('~/.nightshift/plans/&lt;id&gt;') + '. Commands that act on one plan take ' + m('--plan &lt;id&gt;')
        + ' or the id itself, as below.'),
      table([['Command', 'What it does'],
             ['list', 'All plans with status, progress, and whether the runner is on.'],
             ['report --plan ID', 'The morning report: tasks, commits, blockers, limits used, usage, and the merge command.'],
             ['logs ID', 'The last lines of the plan\'s runner log (' + m('--lines 100') + ' for more).'],
             ['pause --plan ID', 'Stop starting new tasks after the current one. ' + m('resume') + ' undoes it.'],
             ['interrupt --plan ID', 'Stop the running turn now (within about a second). The task blocks and the plan pauses.'],
             ['retry TASK --plan ID', 'Requeue a blocked task after you have looked at it; then ' + m('resume') + '. '
              'Use the plan id instead of a task id to reopen a blocked plan.'],
             ['limit NAME VALUE --plan ID', 'Raise or lower a limit, for example ' + m('limit tokens 8000000') + '.'],
             ['stop ID / start ID', 'Stop the background runner after its current step, or start it again.'],
             ['merge ID', 'Your approval: merge the finished branch into the branch it started from (main). Nothing is pushed.'],
             ['discard ID --yes', 'Throw away an unmerged plan: its worktree, its branch, and its folder.']],
            [58 * mm, FULL - 58 * mm], mono_first=True),
      P('What the statuses mean', h2),
      table([['Status', 'Meaning', 'What to do'],
             ['Running', 'Working through tasks.', 'Nothing. Check in when you like.'],
             ['Paused', 'You paused it, or a limit was reached (the report says which).', 'Raise the limit if needed, then resume.'],
             ['Blocked', 'A task failed in a way Nightshift will not retry by itself.', 'Read the reason in the report. Fix or accept it, then retry and resume.'],
             ['Ready to merge', 'Every task and the final review passed.', 'Look at the branch, then merge (or discard).'],
             ['Draft', 'Planned, not started.', 'Start it, or discard it.']],
            [30 * mm, 68 * mm, FULL - 98 * mm]),
      callout('Merging', 'The report prints the exact commands. ' + m('merge') + ' merges into the branch the plan started from, wherever it is checked out, and refuses if that checkout has '
              'uncommitted changes. It aborts cleanly on a conflict, so it never leaves a half-merged '
              'tree. The plan branch is kept after merging.')]

# 5 — The app
s += [PageBreak(), P('The Nightshift app', h1),
      P('A macOS window and menu-bar icon over the same commands, with notifications when a plan needs you or is ready '
        'to merge.', lead),
      P('Where to find it', h2),
      table([['', ''],
             ['The app', m('~/CodexProjects/nightshift/app/build/Nightshift.app')],
             ['Its source', m('~/CodexProjects/nightshift/app/') + ' (SwiftUI)'],
             ['Open it', m('open ~/CodexProjects/nightshift/app/build/Nightshift.app') + ', or double-click it in Finder.'],
             ['Keep it handy', 'Drag it into /Applications (or the Dock). It keeps working from there.'],
             ['Rebuild it', m('~/CodexProjects/nightshift/app/build.sh') + ' after pulling app changes.']],
            [32 * mm, FULL - 32 * mm], header=False),
      P('Run ' + m('setup') + ' once before opening it. Every button runs the matching command, so the app and the terminal agree.'),
      P('What you can do in it', h2),
      table([['Where', 'What'],
             ['Sidebar', 'Every plan with a status icon and progress (for example 4/10).'],
             ['Plan view', 'The brief, repository, branch, agents, runner state, each task with its "done when" criteria, '
              'commits, blockers in red, the final review, limits as bars, and the last log lines.'],
             ['Buttons', 'Approve and Start (drafts, with Works / Reviews pickers), Pause / Resume, Stop Turn, Start / Stop Runner, Retry, Open Worktree, '
              'Report, and Approve and Merge (with a confirmation).'],
             ['Plan Studio', 'New Plan (+). Paste your notes, quick and messy, and press Start Interview. Claude finds the project in '
              'your workspace, reads its code and rules (it cannot change anything), asks questions one at a time (each choice explained, one marked Recommended; '
              'click, press 1 to 9, or use your own words), shows where the plan will start (change it with Starts from), lets you Stop a turn, and writes the roadmap on the right, where you can edit it. Pick who works and who reviews. '
              'Save and Draft Plan writes it into the project and drafts the plan; nothing runs until you press Approve and Start.'],
             ['Accounts', 'Cmd-comma. Each provider\'s version, sign-in (a Sign In button opens your browser; subscription only), '
              'an on/off switch, and Run Setup.'],
             ['Menu bar', 'The moon icon lists plans and opens the window. It fills in when a plan needs you.'],
             ['Notifications', 'One alert when a plan becomes blocked, paused, or ready to merge.']],
            [32 * mm, FULL - 32 * mm]),
      callout('First launch', 'macOS may ask to allow notifications; say yes to get the alerts. The app is signed for '
              'local use only, so if macOS warns that it cannot check it, right-click the app and choose Open once.', ACCENT)]

# 6 — Safety
s += [PageBreak(), P('Safety: what agents can and cannot do', h1),
      P('The limits are enforced by the operating system and by Nightshift\'s own code, not just by instructions to the '
        'agent. They were tested with real agents asked to break them.', lead),
      table([['Agents can', 'Agents cannot'],
             ['Read the project and edit files inside the plan\'s worktree.', 'Write outside the worktree (apart from a temporary folder).'],
             ['Run the commands their task needs: builds, tests, scripts.', 'Reach the network: no web, no package installs, no pushing.'],
             ['See the results of the checks Nightshift runs.', 'Commit, push, rebase, reset, or otherwise change git history.'],
             ['', 'Read your SSH keys, cloud credentials, GitHub login, or keychain.'],
             ['', 'Change files the plan does not allow, or protected files such as AGENTS.md, CLAUDE.md, .github/.'],
             ['', 'Add tasks, change limits, or approve its own work.']],
            [FULL / 2, FULL / 2]),
      P('Your project\'s rules', h2),
      P('Nightshift reads the repository\'s ' + m('AGENTS.md') + ' and ' + m('CLAUDE.md') + ' (plus local and parent-folder ones, '
        'such as the CodexProjects workspace rules), fixes them when a plan starts, and gives them to every agent, however the plan '
        'was started. Where they ask for something Nightshift forbids, Nightshift wins: VSTS\'s "commit and push after every change" '
        'or "install the plugin" become steps the agent lists as left for you, and an attempted commit is refused without stopping '
        'the task. The report and the app show which rule files a plan used.'),
      P('Billing', h2),
      P('Nightshift only runs on subscription sign-ins: claude.ai for Claude, ChatGPT for Codex. Any API-key setting in the '
        'environment is stripped before an agent starts, startup refuses a pay-per-token sign-in, and a turn that reports '
        'an API key is stopped and pauses the plan. There is deliberately no setting to turn this off.'),
      P('For extra peace of mind, keep <b>Usage credits</b> off (or capped) in claude.ai under Settings, Usage. Without them, '
        'reaching your plan limit pauses work instead of charging.'),
      P('Codex on or off', h2),
      P('Codex is currently turned off, to save its usage. Nightshift will not start it, and new plans use Claude for both '
        'the work and the review. Turn it on when you want a second model as reviewer (it caught a real safety bug in the '
        'comparison run):'),
      code('''nightshift enable codex      # turn it back on
nightshift disable codex     # and off again''')]

# 7 — Limits
s += [PageBreak(), P('Kill switches', h1),
      P('Every plan has hard limits so it cannot run away, loop, or drift off topic. Reaching one pauses or blocks the plan '
        'and the report says why. Change any of them with ' + m('limit') + '.'),
      table([['Limit', 'Default', 'When reached'],
             ['Attempts per task', '3', 'The task blocks.'],
             ['Time per turn', '20 minutes', 'The turn is stopped and the task blocks.'],
             ['Dispatches per plan', '3 per task + 2', 'The plan pauses.'],
             ['Tokens per plan', '5 million', 'The plan pauses.'],
             ['Time per plan', '6 hours', 'The plan pauses.'],
             ['Changed lines per task', '800', 'The worker is asked for a smaller change.'],
             ['Same failure twice, or no change at all', 'always on', 'The task blocks (it is going in circles).'],
             ['A file outside the plan, or a protected file', 'always on', 'The task blocks (it is drifting).'],
             ['Fix-up rounds after a failed final review', '1', 'After one fix-up task, the plan blocks.']],
            [70 * mm, 32 * mm, FULL - 102 * mm]),
      P('Limits are checked before each task starts, so the last task before a limit can go slightly over it.', small),
      P('Effort', h2),
      P('The planner rates each task low, medium, or high. The worker starts at that effort and goes one level higher on every '
        'retry, because a failure means the task was harder than rated. Reviewers stay at a fixed high level, so a low rating never '
        'weakens a check. You set the bounds in Accounts or with ' + m('nightshift effort') + ', and can change any task\'s rating '
        'on the draft (or ' + m('nightshift difficulty TASK high --plan ID') + ').')]

# 8 — Troubleshooting
s += [PageBreak(), P('Troubleshooting', h1),
      table([['You see', 'Do this'],
             ['"claude version mismatch"', 'The CLI was updated. Run ' + m('nightshift setup') + ' to accept the new version.'],
             ['"not signed in"', 'Run ' + m('claude auth login') + ' and sign in with your claude.ai account.'],
             ['"codex is turned off"', 'Expected while Codex is off. Use ' + m('--agents claude') + ', or ' + m('enable codex') + '.'],
             ['A plan is blocked', 'Run ' + m('report --plan ID') + ': the reason is at the top. Fix or accept it, then '
              + m('retry') + ' and ' + m('resume') + '.'],
             ['The runner stopped', m('logs ID') + ' shows why; ' + m('start ID') + ' starts it again. Anything in flight '
              'when it stopped is blocked rather than repeated, so you decide.'],
             ['The Mac restarted', 'Runners do not restart by themselves yet. Run ' + m('list') + ', then ' + m('start ID')
              + ' for each plan you want to continue. (' + m('docs/SERVICE.md') + ' shows how to start at login.)'],
             ['merge refuses', 'The checkout that has the target branch (usually main) has uncommitted changes. Commit or stash them first.'],
             ['The app says it is not set up', 'Run ' + m('nightshift setup') + ' once, then reopen the app.'],
             ['The app will not build', 'Use ' + m('app/build.sh') + ': it uses Xcode\'s toolchain, because the Command '
              'Line Tools\' Swift package tool is broken on this Mac.']],
            [52 * mm, FULL - 52 * mm]),
      P('Where things are', h2),
      table([['What', 'Where'],
             ['Nightshift', m('~/CodexProjects/nightshift') + ' (GitHub: omsomso/nightshift, private)'],
             ['Your plans', m('~/.nightshift/plans/&lt;id&gt;') + ': state, draft, runner log, and the worktree'],
             ['Settings', m('~/.nightshift/config.json') + ': pinned versions, which providers are on'],
             ['Design and details', m('docs/EDIT_MODE.md') + ', ' + m('docs/CLAUDE_SETUP.md') + ', ' + m('docs/COMPARISON.md')]],
            [36 * mm, FULL - 36 * mm])]

# 9 — Quick reference
s += [PageBreak(), P('Quick reference', h1),
      code('''# once, and after updating the Claude CLI
nightshift setup

# plan from a document, approve, run in the background
nightshift run ~/path/to/repo/docs/PLAN.md --steps "1-10"
nightshift draft ~/path/to/repo/docs/PLAN.md      # draft only
nightshift start ID

# keep an eye on it
nightshift list
nightshift report --plan ID
nightshift logs ID

# steer it
nightshift pause --plan ID          # and: resume --plan ID
nightshift interrupt --plan ID      # stop the running turn now
nightshift retry TASK --plan ID     # after a blocker; then resume
nightshift limit tokens 8000000 --plan ID
nightshift difficulty TASK high --plan ID  # worker starts at more effort
nightshift stop ID                  # and: start ID

# finish
nightshift merge ID                 # your approval
nightshift discard ID --yes         # or throw it away

# providers
nightshift disable codex            # and: enable codex

# the app
open ~/CodexProjects/nightshift/app/build/Nightshift.app'''),
      Spacer(1, 6),
      callout('The short version', 'Write the steps down. Run ' + m('run') + ' on the document and say yes. Do something '
              'else. When the app or ' + m('list') + ' says <b>Ready to merge</b>, read the report, look at the branch, and '
              'merge it. If it says <b>Blocked</b>, read the reason; that is the moment Nightshift needs you.', GREEN)]

doc.build(s)
print('wrote', OUT)
