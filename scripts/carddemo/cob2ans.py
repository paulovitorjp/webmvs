#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Convert CardDemo's COBOL (COBOL-85 style) to the dialect of the MVT ANS COBOL compiler (IKFCBL00) on MVS 3.8J.

  cob2ans.py SRC.cbl --cpy DIR[,DIR] [--keep-copy NAME,..] [--report] -o OUT.cbl

What it does (only the constructs CardDemo uses):
  * expands COPY members found in --cpy (with REPLACING ==a== BY ==b==); other COPYs stay (BMS maps, KICKS);
    COPY DFHAID / DFHBMSCA become KIKAID / KIKBMSCA
  * structured statements become flat sentences: IF/ELSE/END-IF, EVALUATE, inline PERFORM, READ AT END etc.
    branches that are not simple become generated paragraphs (CDG-nnnn) that are PERFORMed
  * SET cond TO TRUE -> MOVE value TO parent; CONTINUE -> nothing; INITIALIZE -> MOVE SPACES/ZEROS per item
  * >= <= -> NOT < / NOT >; LENGTH OF -> literal; reference modification, STRING, FUNCTION calls ->
    calls of small COBOL helpers (CDMOVC, CDSTRG, CDDATE, ...) and TRANSFORM/EXAMINE
  * EXEC CICS ASSIGN APPLID / INQUIRE PROGRAM: stubs (KICKS has no such commands)
Anything it cannot convert is reported as '*CVT?' comments plus a nonzero exit, to be fixed in the patch files.
"""
import argparse, os, re, sys

VERBS = set('''ACCEPT ADD CALL CLOSE COMPUTE CONTINUE DELETE DISPLAY DIVIDE EVALUATE EXAMINE EXEC EXIT GO GOBACK IF
INITIALIZE INSPECT MOVE MULTIPLY OPEN PERFORM READ REWRITE SEARCH SET START STOP STRING SUBTRACT TRANSFORM UNSTRING
WRITE NEXT ALTER RELEASE RETURN SORT MERGE'''.split())
TERMS = set('ELSE WHEN END-IF END-EVALUATE END-PERFORM END-READ END-WRITE END-REWRITE END-DELETE END-START END-STRING '
            'END-COMPUTE END-ADD END-SUBTRACT END-MULTIPLY END-DIVIDE END-CALL END-SEARCH END-UNSTRING'.split())
LOWER, UPPER = 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'


class CvtError(Exception):
    pass


# ---------------------------------------------------------------- source and COPY
def read_lines(path):
    out = []
    for raw in open(path, encoding='latin-1').read().splitlines():
        raw = raw.rstrip('\r\n').ljust(80)
        ind, txt = raw[6], raw[7:72].rstrip()
        if ind in '*/': continue
        if ind == '-': raise CvtError('continuation line not supported: ' + raw)
        if ind == 'D': continue
        out.append(upper_code(txt))
    return out


def upper_code(txt):
    """words in upper case (the compiler takes no lower case), literals as they are"""
    parts = re.split(r'("[^"]*"?|\'[^\']*\'?)', txt)
    return ''.join(x if x[:1] in ('"', "'") else x.upper() for x in parts)


MAPDIRS = []


def find_member(name, dirs):
    for d in dirs:
        for ext in ('.cpy', '.CPY', ''):
            p = os.path.join(d, name + ext)
            if os.path.isfile(p): return p
    return None


def expand_copies(lines, cpydirs, keep, depth=0):
    out, i = [], 0
    while i < len(lines):
        l = lines[i]
        m = re.match(r"\s*COPY\s+'?([A-Z0-9@#$-]+)'?\s*(.*)$", l)
        if not m:
            out.append(l); i += 1; continue
        name, rest = m.group(1), m.group(2)
        stmt = rest
        while '.' not in re.sub(r"'[^']*'|==[^=]*==", '', stmt):
            if 'REPLACING' not in stmt and i + 1 < len(lines) and not lines[i + 1].strip().startswith('=='):
                break                     # COPY 'X' without a period
            i += 1; stmt += ' ' + lines[i].strip()
        i += 1
        reps = re.findall(r'==(.*?)==\s+BY\s+==(.*?)==', stmt)
        path = None
        for d in cpydirs:
            for ext in ('.cpy', '.CPY', ''):
                p = os.path.join(d, name + ext)
                if os.path.isfile(p): path = p; break
            if path: break
        if path is None or name in keep:
            name = {'DFHAID': 'KIKAID', 'DFHBMSCA': 'KIKBMSCA'}.get(name, name)
            if reps: raise CvtError(f'COPY {name} REPLACING of a member that is not expanded')
            out.append(f'       COPY {name}.'[7:])
            mp = find_member(name, MAPDIRS)
            if mp: out.extend('\x00' + x for x in read_lines(mp))   # symbolic map: model only
            continue
        sub = read_lines(path)
        if reps:
            sub2 = []
            for s in sub:
                for a, b in reps: s = s.replace(a.strip(), b.strip())
                sub2.append(s)
            sub = sub2
        out.extend(expand_copies(sub, cpydirs, keep, depth + 1))
    return out


# ---------------------------------------------------------------- tokens
TOK = re.compile(r"""\s*(?:('(?:[^']|'')*')|("(?:[^"]|"")*")|(==)|(\.)(?=\s|$)|([(),:])|(>=|<=|[<>=+*/])|([A-Z0-9][A-Z0-9-]*(?:\.[0-9A-Z]+)?|-?[0-9]+(?:\.[0-9]+)?|[A-Z0-9-]+))""", re.I)


class T(str):
    """a token; .a = starts in area A (column 8-11), .line = source line number"""
    a = False; line = 0; col = 0; end = 0


def tokenize(lines, start=0):
    toks = []
    for n, l in enumerate(lines):
        pos = 0
        s = l.lstrip('\x00')
        while pos < len(s):
            if s[pos:].strip() == '': break
            m = TOK.match(s, pos)
            if not m: raise CvtError(f'cannot tokenize: {s[pos:]!r} in {l!r}')
            g = next(x for x in m.groups() if x is not None)
            col = m.start(m.lastindex)
            t = T(g if g.startswith(("'", '"')) else g.upper())
            if t.startswith('"'):
                t = T("'" + t[1:-1].replace('""', '"').replace("'", "''") + "'")
            t.a = col < 4; t.line = start + n; t.col = col; t.end = m.end()
            toks.append(t); pos = m.end()
    return toks


# ---------------------------------------------------------------- data division model
class Item:
    def __init__(self, level, name, parent):
        self.level, self.name, self.parent = level, name, parent
        self.pic = None; self.usage = 'DISPLAY'; self.occurs = 1; self.redefines = None
        self.children = []; self.values = []; self.cond = []; self.value = None

    def size(self):
        if self.level == 88: return 0
        if self.children:
            s = sum(c.size() * c.occurs for c in self.children if c.level != 88 and not c.redefines)
            # a group redefined by a longer item: the longest wins
            for c in self.children:
                if c.redefines and c.level != 88:
                    pass
            return s
        if self.pic is None:
            if self.usage in ('INDEX', 'POINTER', 'COMP-1'): return 4
            if self.usage == 'COMP-2': return 8
            return 0
        p = expand_pic(self.pic)
        digits = sum(1 for ch in p if ch in '9')
        if self.usage in ('COMP', 'COMPUTATIONAL', 'BINARY', 'COMP-4'):
            return 2 if digits <= 4 else 4 if digits <= 9 else 8
        if self.usage in ('COMP-3', 'COMPUTATIONAL-3', 'PACKED-DECIMAL'):
            return digits // 2 + 1
        return sum(1 for ch in p if ch not in 'SVP') + p.count('CR') * 0 - p.count('DB') * 0

    def numeric(self):
        if self.children or self.pic is None: return False
        p = expand_pic(self.pic)
        return set(p) <= set('S9VP')

    def num_edited(self):
        """numeric-edited (INITIALIZE moves ZERO to it)"""
        if self.children or self.pic is None: return False
        p = expand_pic(self.pic)
        return not set(p) & set('XA') and bool(set(p) & set('9Z*'))

    def ancestors(self):
        a, p = [], self.parent
        while p is not None: a.append(p.name); p = p.parent
        return a


def expand_pic(p):
    out = ''
    for m in re.finditer(r'(CR|DB|.)(?:\((\d+)\))?', p.upper()):
        out += m.group(1) * (int(m.group(2)) if m.group(2) else 1)
    return out


def parse_data(toks):
    """entries of the DATA DIVISION (tokens after WORKING-STORAGE / LINKAGE / FILE SECTION), returns the item list"""
    items, stack, i = [], [], 0
    sentences, cur = [], []
    for t in toks:
        if t == '.':
            if cur: sentences.append(cur)
            cur = []
        else: cur.append(t)
    for s in sentences:
        if not re.fullmatch(r'\d\d?', s[0]):
            stack = []; continue          # FD / SD / section headers
        lvl = int(s[0])
        name = s[1] if len(s) > 1 and s[1] not in ('PIC', 'PICTURE', 'VALUE', 'REDEFINES', 'OCCURS', 'USAGE', 'COMP', 'COMP-3') else 'FILLER'
        if lvl == 88:
            par = stack[-1] if stack else None
            it = Item(88, name, par)
            vals = []
            j = 2
            while j < len(s) and s[j] in ('VALUE', 'VALUES', 'ARE', 'IS'): j += 1
            vals = s[j:]
            it.values = vals
            if par is not None: par.cond.append(it)
            items.append(it); continue
        if lvl == 66: continue
        while stack and (stack[-1].level >= lvl or stack[-1].level == 77): stack.pop()
        par = stack[-1] if stack and lvl not in (1, 77) else None
        it = Item(lvl, name, par)
        j = 2 if name != 'FILLER' or (len(s) > 1 and s[1] == 'FILLER') else 1
        while j < len(s):
            w = s[j]
            if w in ('PIC', 'PICTURE'):
                j += 1
                if s[j] == 'IS': j += 1
                pic = s[j]
                while j + 1 < len(s) and s[j + 1] == '(':      # tokenizer splits X(10) -> X ( 10 )
                    pic += '(' + s[j + 2] + ')'; j += 3
                    if j + 1 < len(s) and re.fullmatch(r'[A-Z0-9V]+', s[j + 1]) and s[j + 1] not in ('VALUE', 'VALUES', 'COMP', 'COMP-3', 'USAGE', 'OCCURS', 'REDEFINES', 'BINARY', 'SYNC', 'DISPLAY', 'COMPUTATIONAL', 'COMPUTATIONAL-3', 'PACKED-DECIMAL', 'JUST', 'JUSTIFIED', 'BLANK', 'SIGN', 'INDEXED', 'TIMES'):
                        j += 1; pic += s[j]
                # an edited picture is split by the tokenizer (+ZZZ,ZZZ.99): join the tokens that touch
                while j + 1 < len(s) and s[j + 1].line == s[j].line and s[j + 1].col == s[j].end and s[j].end > 0:
                    j += 1; pic += s[j]
                it.pic = pic
            elif w in ('COMP', 'COMPUTATIONAL', 'BINARY', 'COMP-4', 'COMP-3', 'COMPUTATIONAL-3', 'PACKED-DECIMAL', 'COMP-1', 'COMP-2', 'INDEX', 'POINTER'):
                it.usage = w
            elif w == 'REDEFINES':
                j += 1; it.redefines = s[j]
            elif w == 'OCCURS':
                j += 1; n = int(s[j])
                if j + 2 < len(s) and s[j + 1] == 'TO': n = int(s[j + 2]); j += 2
                it.occurs = n
            elif w in ('VALUE', 'VALUES'):
                it.value = s[j + 1] if j + 1 < len(s) else None
            j += 1
        if par is not None: par.children.append(it)
        items.append(it); stack.append(it)
    return items


class Model:
    def __init__(self, items):
        self.items = items
        self.by = {}
        for it in items: self.by.setdefault(it.name, []).append(it)

    def find(self, name, quals=()):
        c = self.by.get(name, [])
        if quals: c = [x for x in c if all(q in x.ancestors() for q in quals)]
        return c[0] if c else None


# ---------------------------------------------------------------- procedure division parse
class St:
    def __init__(self, kind, **kw):
        self.kind = kind; self.__dict__.update(kw)


class Parser:
    def __init__(self, toks, paras):
        self.t, self.i, self.paras = toks, 0, paras

    def peek(self, k=0):
        j = self.i + k
        return self.t[j] if j < len(self.t) else None

    def take(self):
        t = self.t[self.i]; self.i += 1; return t

    def at_stmt_start(self, t):
        return t in VERBS

    def stmts(self, stop):
        out = []
        while True:
            t = self.peek()
            if t is None or t == '.' or t in stop or t in TERMS or (t.a and t != '.'):
                return out
            if t in ('NOT',) and self.peek(1) in ('AT', 'INVALID', 'ON', 'END'):
                return out
            if t in ('AT', 'INVALID') or (t == 'ON' and self.peek(1) in ('SIZE', 'OVERFLOW', 'EXCEPTION')):
                return out
            out.append(self.stmt())

    def until_verb(self, stop=()):
        out = []
        while True:
            t = self.peek()
            if t is None or t == '.' or t in VERBS or t in TERMS or t in stop or (t.a):
                return out
            out.append(self.take())

    def stmt(self):
        t = self.take()
        if t == 'IF':
            cond = []
            while True:
                x = self.peek()
                if x is None or x == '.' or x in VERBS or x in TERMS or x == 'THEN': break
                cond.append(self.take())
            if self.peek() == 'THEN': self.take()
            if self.peek() == 'NEXT': self.take(); self.take(); th = [St('next')]
            else: th = self.stmts({'ELSE'})
            el = []
            if self.peek() == 'ELSE':
                self.take()
                if self.peek() == 'NEXT': self.take(); self.take(); el = [St('next')]
                else: el = self.stmts(set())
            if self.peek() == 'END-IF': self.take()
            return St('if', cond=cond, then=th, els=el)
        if t == 'EVALUATE':
            subj = self.until_verb({'WHEN'})
            whens = []
            while self.peek() == 'WHEN':
                objs = []
                while self.peek() == 'WHEN':
                    self.take(); o = []
                    while True:
                        x = self.peek()
                        if x is None or x == '.' or x in VERBS or x in TERMS: break
                        o.append(self.take())
                    objs.append(o)
                body = self.stmts(set())
                whens.append((objs, body))
            if self.peek() == 'END-EVALUATE': self.take()
            return St('evaluate', subj=subj, whens=whens)
        if t == 'PERFORM':
            x = self.peek()
            if x in self.paras:
                rest = self.until_verb()
                return St('perform', target=rest)
            # inline
            head = []
            while True:
                x = self.peek()
                if x is None or x == '.' or x in VERBS or x in TERMS: break
                head.append(self.take())
            body = self.stmts(set())
            if self.peek() != 'END-PERFORM': raise CvtError(f'inline PERFORM without END-PERFORM near line {t.line}')
            self.take()
            return St('iperform', head=head, body=body)
        if t in ('READ', 'WRITE', 'REWRITE', 'DELETE', 'START'):
            args = self.until_verb({'AT', 'INVALID', 'NOT'})
            branches = {}
            while True:
                x = self.peek()
                if x == 'AT' and self.peek(1) == 'END': self.take(); self.take(); branches['end'] = self.stmts(set())
                elif x == 'END' and t == 'READ' and False: pass
                elif x == 'NOT' and self.peek(1) == 'AT': self.take(); self.take(); self.take(); branches['notend'] = self.stmts(set())
                elif x == 'NOT' and self.peek(1) == 'END': self.take(); self.take(); branches['notend'] = self.stmts(set())
                elif x == 'INVALID': self.take(); self.take() if self.peek() == 'KEY' else None; branches['inv'] = self.stmts(set())
                elif x == 'NOT' and self.peek(1) == 'INVALID':
                    self.take(); self.take(); self.take() if self.peek() == 'KEY' else None; branches['notinv'] = self.stmts(set())
                else: break
            if self.peek() == 'END-' + t: self.take()
            return St('io', verb=t, args=args, br=branches)
        if t == 'EXEC':
            body = []
            while self.peek() != 'END-EXEC': body.append(self.take())
            self.take()
            return St('exec', body=body)
        if t == 'NEXT':
            self.take(); return St('next')
        if t == 'STRING':
            args = []
            while True:
                x = self.peek()
                if x is None or x == '.' or (x in VERBS and (x != 'STRING' or args)) or (x in TERMS and x != 'END-STRING'): break
                if x == 'END-STRING': self.take(); break
                args.append(self.take())
            return St('string', args=args)
        if t == 'GO':
            args = self.until_verb()
            return St('simple', verb='GO', args=args)
        args = self.until_verb()
        # ON SIZE ERROR etc. not used by CardDemo online
        for e in ('END-' + t,):
            if self.peek() == e: self.take()
        return St('simple', verb=str(t), args=args)


# ---------------------------------------------------------------- generation
class Gen:
    def __init__(self, model, name):
        self.m, self.name = model, name
        self.paras = []         # (name, [sentences])
        self.n = 0
        self.ws = []            # extra WORKING-STORAGE lines
        self.lit = {}
        self.tmp = 0; self.tmpsize = {}
        self.warn = []

    def newpara(self, sentences):
        self.n += 1
        nm = f'CDG-{self.n:04d}'
        self.paras.append((nm, sentences))
        return nm

    # -------- helpers for data
    def ref(self, toks, k):
        """parse an identifier at toks[k]: NAME [OF|IN Q]* [ (subs) ] [ (a:b) ] -> (end index, dict)"""
        name = toks[k]; j = k + 1; quals = []
        while j + 1 < len(toks) and toks[j] in ('OF', 'IN'):
            quals.append(toks[j + 1]); j += 2
        subs = None; rm = None
        while j < len(toks) and toks[j] == '(':
            depth, e = 0, j
            while True:
                if toks[e] == '(': depth += 1
                elif toks[e] == ')':
                    depth -= 1
                    if depth == 0: break
                e += 1
            inner = toks[j + 1:e]
            if ':' in inner:
                c = inner.index(':'); rm = (inner[:c], inner[c + 1:])
            else:
                subs = inner
            j = e + 1
            while j + 1 < len(toks) and toks[j] in ('OF', 'IN'):
                quals.append(toks[j + 1]); j += 2
        return j, dict(name=name, quals=quals, subs=subs, rm=rm)

    def size_of(self, name, quals=()):
        it = self.m.find(name, quals)
        if it is None: raise CvtError(f'unknown data item {name} {quals}')
        return it.size()

    def item(self, name, quals=()):
        return self.m.find(name, quals)

    def const_num(self, v):
        k = ('N', v)
        if k not in self.lit:
            nm = f'CDN-{len(self.lit) + 1:03d}'
            self.lit[k] = nm
            self.ws.append(f'       01  {nm} PIC S9(8) COMP VALUE {v}.')
        return self.lit[k]

    def const_lit(self, lit):
        k = ('L', lit)
        if k not in self.lit:
            nm = f'CDL-{len(self.lit) + 1:03d}'
            self.lit[k] = nm
            n = len(lit[1:-1].replace("''", "'"))
            self.ws.extend(wrap_value(f'       01  {nm} PIC X({max(n, 1)}) VALUE', lit))
        return self.lit[k], len(lit[1:-1].replace("''", "'"))

    def newtmp(self, pic):
        self.tmp += 1
        nm = f'CDT-{self.tmp:03d}'
        self.ws.append(f'       01  {nm} PIC {pic}.')
        m = re.fullmatch(r'X\((\d+)\)', pic)
        if m: self.tmpsize[nm] = int(m.group(1))
        return nm

    def xsize(self, toks):
        """size of an alphanumeric operand (after fix_expr): a data item, a temp or a literal"""
        if len(toks) == 1 and toks[0] in self.tmpsize: return self.tmpsize[toks[0]]
        if len(toks) == 1 and toks[0][:1] in ('"', "'"): return len(toks[0]) - 2
        j, r = self.ref(toks, 0)
        return self.size_of(r['name'], r['quals'])

    @staticmethod
    def unwrap_trim(arg):
        """FUNCTION TRIM(x [LEADING|TRAILING]) -> (x, True); anything else -> (arg, False)"""
        if arg[:3] == ['FUNCTION', 'TRIM', '('] and arg[-1] == ')':
            return [x for x in arg[3:-1] if x not in ('TRAILING', 'LEADING')], True
        return arg, False

    def text(self, r):
        s = r['name']
        for q in r['quals']: s += ' OF ' + q
        if r['subs']: s += ' (' + ' '.join(r['subs']) + ')'
        return s

    # -------- expressions with refmod / LENGTH OF / FUNCTION
    def fix_expr(self, toks, pre):
        """rewrite a token list (operands of a statement or condition): refmod as source -> temp, LENGTH OF -> literal,
        >= / <= -> NOT < / NOT >, FUNCTION UPPER-CASE etc. Pre-statements go to pre."""
        out, k = [], 0
        while k < len(toks):
            t = toks[k]
            if t == 'LENGTH' and k + 1 < len(toks) and toks[k + 1] == 'OF':
                j, r = self.ref(toks, k + 2)
                out.append(str(self.size_of(r['name'], r['quals']))); k = j; continue
            if t == 'FUNCTION':
                j, txt = self.function(toks, k, pre)
                out.append(txt); k = j; continue
            if t in ('>=',): out += ['NOT', '<']; k += 1; continue
            if t in ('<=',): out += ['NOT', '>']; k += 1; continue
            if t == 'GREATER' and toks[k + 1:k + 4] in (['THAN', 'OR', 'EQUAL'], ['OR', 'EQUAL', 'TO']):
                out += ['NOT', 'LESS']; k += 1
                while k < len(toks) and toks[k] in ('THAN', 'OR', 'EQUAL', 'TO'): k += 1
                continue
            if t == 'LESS' and toks[k + 1:k + 4] in (['THAN', 'OR', 'EQUAL'], ['OR', 'EQUAL', 'TO']):
                out += ['NOT', 'GREATER']; k += 1
                while k < len(toks) and toks[k] in ('THAN', 'OR', 'EQUAL', 'TO'): k += 1
                continue
            if re.fullmatch(r'[A-Z][A-Z0-9-]*', t) and t not in RESERVED and self.item(t) is not None:
                j, r = self.ref(toks, k)
                if r['rm']:
                    out.append(self.refmod_get(r, pre)); k = j; continue
                out.append(self.text(r)); k = j; continue
            out.append(t); k += 1
        return out

    def num_operand(self, toks, pre):
        """a number expression (refmod offset/length) -> name of a S9(8) COMP item holding it"""
        toks = self.fix_expr(toks, pre)
        if len(toks) == 1 and re.fullmatch(r'\d+', toks[0]): return self.const_num(int(toks[0]))
        nm = self.newtmp('S9(8) COMP')
        pre.append(f'COMPUTE {nm} = ' + ' '.join(toks))
        return nm

    def rm_parts(self, r, pre):
        base = dict(r, rm=None)
        a, b = r['rm']
        off = self.num_operand(a, pre)
        if b:
            ln = self.num_operand(b, pre)
            const = len(b) == 1 and re.fullmatch(r'\d+', b[0]) and int(b[0])
        else:
            total = self.size_of(r['name'], r['quals'])
            if len(a) == 1 and re.fullmatch(r'\d+', a[0]):
                const = total - int(a[0]) + 1; ln = self.const_num(const)
            else:
                ln = self.newtmp('S9(8) COMP'); pre.append(f'COMPUTE {ln} = {total} - {off} + 1'); const = None
        return base, off, ln, const

    def refmod_get(self, r, pre):
        base, off, ln, const = self.rm_parts(r, pre)
        size = const or self.size_of(r['name'], r['quals'])
        tmp = self.newtmp(f'X({size})')
        pre.append(f"CALL 'CDMOVC' USING {self.text(base)} {off} {ln} {tmp} {self.const_num(1)} {self.const_num(size)}")
        return tmp

    def refmod_put(self, r, src_tmp, src_len_name, pre_post):
        base, off, ln, const = self.rm_parts(r, pre_post)
        pre_post.append(f"CALL 'CDMOVC' USING {src_tmp} {self.const_num(1)} {src_len_name} {self.text(base)} {off} {ln}")

    def function(self, toks, k, pre):
        fn = toks[k + 1]
        if fn == 'CURRENT-DATE':
            tmp = self.newtmp('X(21)')
            pre.append(f"CALL 'CDDATE' USING {tmp}")
            return k + 2, tmp
        if fn in ('UPPER-CASE', 'LOWER-CASE', 'TRIM', 'NUMVAL', 'NUMVAL-C', 'LENGTH', 'INTEGER-OF-DATE', 'DATE-OF-INTEGER', 'TEST-NUMVAL-C', 'TEST-NUMVAL', 'MOD'):
            assert toks[k + 2] == '('
            depth, e = 0, k + 2
            while True:
                if toks[e] == '(': depth += 1
                elif toks[e] == ')':
                    depth -= 1
                    if depth == 0: break
                e += 1
            arg = toks[k + 3:e]
            if fn in ('UPPER-CASE', 'LOWER-CASE'):
                arg, _ = self.unwrap_trim(arg)   # comparisons pad with spaces: TRIM only drops leading spaces
                argx = self.fix_expr(arg, pre)
                if arg[0] == 'FUNCTION': size = self.xsize(argx)
                else:
                    j, r = self.ref(arg, 0)
                    size = self.size_of(r['name'], r['quals']) if not r['rm'] else None
                if size is None:
                    it = None; size = 80
                tmp = self.newtmp(f'X({size})')
                pre.append(f'MOVE {" ".join(argx)} TO {tmp}')
                a, b = (LOWER, UPPER) if fn == 'UPPER-CASE' else (UPPER, LOWER)
                pre.append(f"TRANSFORM {tmp} FROM '{a}' TO '{b}'")
                return e + 1, tmp
            if fn == 'LENGTH':
                inner, trimmed = self.unwrap_trim(arg)
                if trimmed:   # the length without leading and trailing spaces, 0 for all spaces
                    argx = self.fix_expr(inner, pre)
                    res = self.newtmp('S9(8) COMP')
                    pre.append(f"CALL 'CDTLEN' USING {' '.join(argx)} {self.const_num(self.xsize(argx))} {res}")
                    return e + 1, res
                j, r = self.ref(arg, 0)
                return e + 1, str(self.size_of(r['name'], r['quals']))
            if fn == 'TRIM':
                # TRIM(x) / TRIM(x TRAILING): used in STRING ... DELIMITED BY SIZE and comparisons; trailing spaces
                # only matter in STRING (handled there); elsewhere the field itself
                arg = [x for x in arg if x not in ('TRAILING', 'LEADING')]
                return e + 1, ' '.join(self.fix_expr(arg, pre))
            if fn in ('NUMVAL', 'NUMVAL-C'):
                argx = self.fix_expr(arg, pre)
                tmp = self.newtmp('S9(13)V99 COMP-3')
                src = self.newtmp('X(40)')
                pre.append(f'MOVE {" ".join(argx)} TO {src}')
                pre.append(f"CALL 'CDNUMV' USING {src} {tmp}")
                return e + 1, tmp
            if fn == 'MOD':   # MOD(a, b) for non-negative integers: a - (a / b) * b
                comma = arg.index(',') if ',' in arg else None
                if comma is None: raise CvtError('FUNCTION MOD without a comma')
                a, b = self.fix_expr(arg[:comma], pre), self.fix_expr(arg[comma + 1:], pre)
                q = self.newtmp('S9(15) COMP-3'); res = self.newtmp('S9(15) COMP-3')
                pre.append(f'COMPUTE {q} = ' + ' '.join(a) + ' / ' + ' '.join(b))
                pre.append(f'COMPUTE {res} = ' + ' '.join(a) + f' - {q} * ' + ' '.join(b))
                return e + 1, res
            if fn in ('INTEGER-OF-DATE', 'DATE-OF-INTEGER'):   # helpers/CDIDAT.cbl
                argx = self.fix_expr(arg, pre)
                src = self.newtmp('S9(8) COMP'); res = self.newtmp('S9(8) COMP')
                pre.append(f'COMPUTE {src} = ' + ' '.join(argx))
                pre.append(f"CALL '{'CDIDAT' if fn == 'INTEGER-OF-DATE' else 'CDDOFI'}' USING {src} {res}")
                return e + 1, res
            if fn in ('TEST-NUMVAL-C', 'TEST-NUMVAL'):
                argx = self.fix_expr(arg, pre)
                tmp = self.newtmp('S9(8) COMP'); val = self.newtmp('S9(13)V99 COMP-3'); src = self.newtmp('X(40)')
                pre.append(f'MOVE {" ".join(argx)} TO {src}')
                pre.append(f"CALL 'CDNUMT' USING {src} {val} {tmp}")
                return e + 1, tmp
        raise CvtError(f'FUNCTION {fn} not supported')

    # -------- statements
    def simple_ok(self, sents):
        """sentences that can sit inside an IF branch: no IF in them"""
        return all(not s.startswith('IF ') and 'NEXT SENTENCE' not in s for s in sents)

    def branch(self, stmts):
        """an IF branch -> text to put after IF cond / ELSE"""
        sents = self.gen(stmts)
        if not sents: return 'NEXT SENTENCE'
        if self.simple_ok(sents) and len(sents) <= 6 and not any(s.startswith('EXEC') for s in sents):
            return ' '.join(sents)
        return 'PERFORM ' + self.newpara(sents)

    def cond(self, toks, pre):
        return ' '.join(self.fix_expr(self.guard_zero(self.class_refmod(toks, pre)), pre))

    CLASSES = {'NUMERIC': "'N'", 'ALPHABETIC': "'A'", 'SPACE': "'S'", 'SPACES': "'S'", 'LOW-VALUE': "'L'", 'LOW-VALUES': "'L'"}

    def class_refmod(self, toks, pre):
        """x(a:n) [IS] [NOT] NUMERIC|ALPHABETIC and x(a:n) [NOT] = SPACES|LOW-VALUES with a variable n: the temp of a
        reference modification is space filled to the full size, so the test goes to helpers/CDCLAS.cbl instead"""
        out, k = [], 0
        while k < len(toks):
            t = toks[k]
            if re.fullmatch(r'[A-Z][A-Z0-9-]*', t) and t not in RESERVED and self.item(t) is not None:
                j, r = self.ref(toks, k)
                if r['rm'] and r['rm'][1] and not (len(r['rm'][1]) == 1 and re.fullmatch(r'\d+', r['rm'][1][0])):
                    rest = toks[j:]; m = 0
                    if rest[m:m + 1] == ['IS']: m += 1
                    neg = rest[m:m + 1] == ['NOT']
                    if neg: m += 1
                    kind = None
                    if rest[m:m + 1] and rest[m] in ('NUMERIC', 'ALPHABETIC'): kind = rest[m]; m += 1
                    elif rest[m:m + 1] in (['='], ['EQUAL']):
                        m2 = m + 1 + (rest[m + 1:m + 2] == ['TO'])
                        if rest[m2:m2 + 1] and rest[m2] in ('SPACE', 'SPACES', 'LOW-VALUE', 'LOW-VALUES'):
                            kind = rest[m2]; m = m2 + 1
                    if kind:
                        base, off, ln, _ = self.rm_parts(r, pre)
                        flag = self.newtmp('X')
                        lit, _ = self.const_lit(self.CLASSES[kind])
                        pre.append(f"CALL 'CDCLAS' USING {self.text(base)} {off} {ln} {lit} {flag}")
                        out += [flag] + (['NOT'] if neg else []) + ['=', "'Y'"]
                        k = j + m; continue
            out.append(t); k += 1
        return out

    ZEROS = ('0', 'ZERO', 'ZEROS', 'ZEROES')
    RELOPS = ('=', '<', '>', '>=', '<=', 'EQUAL', 'THAN', 'TO', 'GREATER', 'LESS')

    def guard_zero(self, toks):
        """x = 0 on a DISPLAY numeric item -> (x NOT NUMERIC OR x = 0); x NOT = 0 -> (x NUMERIC AND x NOT = 0).
        Enterprise COBOL compares spaces or low-values in a zoned field as zero; this compiler stops with a data
        exception (S0C7). CardDemo tests fields that can hold spaces this way (CC-CARD-NUM-N = 0)."""
        out, k = [], 0
        while k < len(toks):
            t = toks[k]
            if (re.fullmatch(r'[A-Z][A-Z0-9-]*', t) and t not in RESERVED and (not out or out[-1] not in self.RELOPS)):
                it = self.item(t)
                if it is not None and it.numeric() and it.usage == 'DISPLAY':
                    j, r = self.ref(toks, k)
                    ref, rest = toks[k:j], toks[j:]
                    if not r['rm']:
                        neg = rest[:1] == ['NOT']
                        r2 = rest[1:] if neg else rest
                        if r2[:1] == ['IS']: r2 = r2[1:]
                        n = 0
                        if r2[:1] == ['='] and r2[1:2] and r2[1] in self.ZEROS: n = 2
                        elif r2[:2] == ['EQUAL', 'TO'] and r2[2:3] and r2[2] in self.ZEROS: n = 3
                        elif r2[:1] == ['EQUAL'] and r2[1:2] and r2[1] in self.ZEROS: n = 2
                        if n:
                            used = len(rest) - len(r2) + n
                            if neg: out += ['('] + ref + ['NUMERIC', 'AND'] + ref + ['NOT', '=', '0', ')']
                            else: out += ['('] + ref + ['NOT', 'NUMERIC', 'OR'] + ref + ['=', '0', ')']
                            k = j + used; continue
            out.append(t); k += 1
        return out

    def gen(self, stmts):
        out = []
        for s in stmts: out.extend(self.gen1(s))
        return out

    def gen1(self, s):
        pre = []
        k = s.kind
        if k == 'next': return []
        if k == 'if':
            c = self.cond(s.cond, pre)
            th = self.branch(s.then); el = self.branch(s.els) if s.els else None
            if th == 'NEXT SENTENCE' and el is None: return pre
            return pre + [f'IF {c} {th}' + (f' ELSE {el}' if el else '')]
        if k == 'evaluate':
            subj = s.subj
            parts = []
            other = None
            for objs, body in s.whens:
                conds = []
                for o in objs:
                    if o == ['OTHER']: conds = None; break
                    if subj == ['TRUE']:
                        conds.append('(' + self.cond(o, pre) + ')' if len(o) > 1 else self.cond(o, pre))
                    elif subj == ['FALSE']:
                        conds.append('NOT (' + self.cond(o, pre) + ')')
                    else:
                        sx = self.cond(subj, pre)
                        if 'THRU' in o or 'THROUGH' in o:
                            t = o.index('THRU') if 'THRU' in o else o.index('THROUGH')
                            conds.append(f'({sx} NOT < {self.cond(o[:t], pre)} AND {sx} NOT > {self.cond(o[t + 1:], pre)})')
                        elif o and o[0] == 'NOT':
                            conds.append(f'{sx} NOT = {self.cond(o[1:], pre)}')
                        else:
                            conds.append(f'{sx} = {self.cond(o, pre)}')
                if conds is None: other = body; break
                parts.append((' OR '.join(conds), body))
            if not parts:
                return pre + self.gen(other or [])
            txt = ''
            for i, (c, body) in enumerate(parts):
                txt += ('IF ' if i == 0 else ' ELSE IF ') + c + ' ' + self.branch(body)
            if other is not None:
                b = self.branch(other)
                if b != 'NEXT SENTENCE': txt += ' ELSE ' + b
            return pre + [txt]
        if k == 'perform':
            return pre + ['PERFORM ' + ' '.join(self.fix_expr(s.target, pre))]
        if k == 'iperform':
            h = s.head
            body = self.gen(s.body)
            p = self.newpara(body)
            after = False
            if h[:3] == ['WITH', 'TEST', 'AFTER']: after = True; h = h[3:]
            elif h[:3] == ['WITH', 'TEST', 'BEFORE']: h = h[3:]
            hx = ' '.join(self.fix_expr(h, pre))
            if pre and 'UNTIL' in h:
                return self.loop_with_pre(h, s.body, after)
            if after: return pre + [f'PERFORM {p}', f'PERFORM {p} {hx}']
            return pre + [f'PERFORM {p} {hx}'.rstrip()]
        if k == 'io':
            args = ' '.join(self.fix_expr(s.args, pre))
            br = s.br
            fi = getattr(self, 'files', {}).get(s.args[0], {}) if s.args else {}
            st = fi.get('status')
            if fi.get('nominal') and s.verb == 'READ': pre = pre + [f"MOVE {fi['rkey']} TO {fi['nominal']}"]
            if st and s.verb == 'READ' and not br:
                return pre + [f"MOVE '00' TO {st}", f"READ {args} AT END MOVE '10' TO {st}"]
            if not br: return pre + [f'{s.verb} {args}']
            flag = 'CDG-IOFLAG'
            if not any('CDG-IOFLAG' in w for w in self.ws): self.ws.append('       01  CDG-IOFLAG PIC X VALUE SPACE.')
            if 'end' in br or 'notend' in br:
                out = pre + [f"MOVE 'N' TO {flag}", f"{s.verb} {args} AT END MOVE 'Y' TO {flag}"]
                yes, no = br.get('end', []), br.get('notend', [])
            else:
                out = pre + [f"MOVE 'N' TO {flag}", f"{s.verb} {args} INVALID KEY MOVE 'Y' TO {flag}"]
                yes, no = br.get('inv', []), br.get('notinv', [])
            # the flag may change inside the branches: copy it
            f2 = self.newtmp('X')
            out.append(f'MOVE {flag} TO {f2}')
            if yes: out.append(f"IF {f2} = 'Y' {self.branch(yes)}")
            if no: out.append(f"IF {f2} = 'N' {self.branch(no)}")
            return out
        if k == 'exec':
            return self.exec_(s.body, pre)
        if k == 'string':
            return self.string(s.args)
        return self.simple(s.verb, s.args)

    def loop_with_pre(self, h, body, after):
        """inline PERFORM [VARYING x FROM a BY b] UNTIL cond, where cond needs statements (reference modification):
        the condition goes into a flag paragraph that is run before each test"""
        flag = self.newtmp('X')
        u = h.index('UNTIL')
        cpre = []
        c = self.cond(h[u + 1:], cpre)
        ev = self.newpara(cpre + [f"MOVE 'N' TO {flag}", f"IF {c} MOVE 'Y' TO {flag}"])
        init, step = [], []
        if h[0] == 'VARYING':
            f, b = h.index('FROM'), h.index('BY')
            var = ' '.join(self.fix_expr(h[1:f], init))
            init.append(f"MOVE {' '.join(self.fix_expr(h[f + 1:b], init))} TO {var}")
            step.append(f"ADD {' '.join(self.fix_expr(h[b + 1:u], init))} TO {var}")
        elif h[0] != 'UNTIL': raise CvtError('inline PERFORM ' + ' '.join(h))
        sents = self.gen(body)
        p = self.newpara(sents + step + [f'PERFORM {ev}'])
        if after: return init + [f'PERFORM {p}', f"PERFORM {p} UNTIL {flag} = 'Y'"]
        return init + [f'PERFORM {ev}', f"PERFORM {p} UNTIL {flag} = 'Y'"]

    def exec_(self, body, pre):
        b = list(body)
        if b[:2] == ['CICS', 'ASSIGN']:
            # ASSIGN APPLID / SYSID: KICKS has no ASSIGN; the name shown is KICKS
            out = []
            for opt in ('APPLID', 'SYSID'):
                if opt in b:
                    i = b.index(opt); j, r = self.ref(b, i + 2)
                    out.append(f"MOVE 'KICKS' TO {self.text(r)}")
            if not out: raise CvtError('ASSIGN ' + ' '.join(b))
            return out
        if b[:2] == ['CICS', 'INQUIRE']:
            # INQUIRE PROGRAM(x) NOHANDLE: KICKS has none. Programs are checked by the menu table instead.
            if 'RESP' in b:
                i = b.index('RESP'); j, r = self.ref(b, i + 2)
                return [f'MOVE 0 TO {self.text(r)}']
            return []
        # LENGTH OF inside EXEC -> literal; refmod inside EXEC args -> not handled
        out, k = [], 0
        while k < len(b):
            if b[k] == 'LENGTH' and k + 1 < len(b) and b[k + 1] == 'OF':
                j, r = self.ref(b, k + 2)
                out.append(str(self.size_of(r['name'], r['quals']))); k = j; continue
            if b[k] == '(' and k + 1 < len(b) and False: pass
            out.append(b[k]); k += 1
        txt = compact(' '.join(out))
        if ':' in out: raise CvtError('reference modification inside EXEC: ' + txt)
        return pre + ['EXEC ' + txt + ' END-EXEC']

    def string(self, args):
        """STRING a [DELIMITED BY SIZE|SPACE|lit] ... INTO t [WITH POINTER p]"""
        pre = []
        args = [x for x in args if x != ',']   # separator commas
        if 'INTO' not in args: raise CvtError('STRING without INTO')
        i = args.index('INTO')
        srcs, rest = args[:i], args[i + 1:]
        j, tr = self.ref(rest, 0)
        ptr = None
        if j < len(rest):
            r2 = rest[j:]
            if r2[:2] == ['WITH', 'POINTER'] or r2[:1] == ['POINTER']:
                r2 = r2[2:] if r2[0] == 'WITH' else r2[1:]
                _, pr = self.ref(r2, 0); ptr = self.text(pr)
            else: raise CvtError('STRING options ' + ' '.join(r2))
        # group sources by their DELIMITED phrase
        groups, cur = [], []
        k = 0
        while k < len(srcs):
            if srcs[k] == 'DELIMITED':
                k += 1
                if srcs[k] == 'BY': k += 1
                d = srcs[k]; k += 1
                groups.append((cur, d)); cur = []
                continue
            cur.append(srcs[k]); k += 1
        if cur: groups.append((cur, 'SIZE'))
        P = 'CDG-PTR'
        if not any(' CDG-PTR ' in w for w in self.ws): self.ws.append('       01  CDG-PTR PIC S9(8) COMP VALUE 1.')
        out = []
        out.append(f'MOVE {ptr} TO {P}' if ptr else f'MOVE 1 TO {P}')
        tsize = self.size_of(tr['name'], tr['quals'])
        tname = self.text(tr)
        if tr['rm']: raise CvtError('STRING INTO a reference modification')
        for ops, d in groups:
            mode = {'SIZE': 0, 'SPACE': 1, 'SPACES': 1}.get(d)
            if mode is None:
                if d == "'  '": mode = 2
                elif re.fullmatch(r"'.'", d): mode = 3
                else: raise CvtError('STRING DELIMITED BY ' + d)
            k = 0
            while k < len(ops):
                o = ops[k]
                trim = False
                if o.startswith("'"):
                    nm, n = self.const_lit(o); k += 1
                elif o in ('SPACE', 'SPACES'):
                    nm, n = self.const_lit("' '"); k += 1
                elif o == 'FUNCTION' and ops[k + 1] == 'TRIM':
                    e = k + 2; depth = 0
                    while True:
                        if ops[e] == '(': depth += 1
                        elif ops[e] == ')':
                            depth -= 1
                            if depth == 0: break
                        e += 1
                    inner = [x for x in ops[k + 3:e] if x not in ('TRAILING',)]
                    j, r = self.ref(inner, 0)
                    if r['rm']: nm = self.refmod_get(r, out); n = self.size_of(r['name'], r['quals'])
                    else: nm, n = self.text(r), self.size_of(r['name'], r['quals'])
                    trim = True; k = e + 1
                else:
                    j, r = self.ref(ops, k); k = j
                    if r['rm']:
                        base, off, ln, const = self.rm_parts(r, out)
                        n = const or self.size_of(r['name'], r['quals'])
                        nm = self.newtmp(f'X({n})')
                        out.append(f"CALL 'CDMOVC' USING {self.text(base)} {off} {ln} {nm} {self.const_num(1)} {self.const_num(n)}")
                        if not const:
                            # variable length: copy only that many
                            out.append(f"CALL 'CDSTRG' USING {tname} {self.const_num(tsize)} {P} {nm} {ln} {self.const_num(4 if trim else mode)}")
                            continue
                    else:
                        nm, n = self.text(r), self.size_of(r['name'], r['quals'])
                m = 4 if trim and mode == 0 else mode
                out.append(f"CALL 'CDSTRG' USING {tname} {self.const_num(tsize)} {P} {nm} {self.const_num(n)} {self.const_num(m)}")
        if ptr: out.append(f'MOVE {P} TO {ptr}')
        return pre + out

    def simple(self, verb, args):
        pre = []
        if verb == 'CONTINUE': return []
        if verb == 'EXIT' and not args: return ['EXIT']
        if verb == 'SET':
            if args[-2:] == ['TO', 'TRUE']:
                out = []
                names = args[:-2]
                k = 0
                while k < len(names):
                    j, r = self.ref(names, k); k = j
                    c = [x for x in self.m.by.get(r['name'], []) if x.level == 88]
                    if r['quals']: c = [x for x in c if all(q in x.ancestors() for q in r['quals'])]
                    if not c: raise CvtError('SET of unknown condition ' + r['name'])
                    cn = c[0]; p = cn.parent
                    v = cn.values[0]
                    tgt = p.name + (' (' + ' '.join(r['subs']) + ')' if r['subs'] else '')
                    qs = [q for q in r['quals'] if q != p.name]
                    for q in qs: tgt += ' OF ' + q
                    out.append(f'MOVE {v} TO {tgt}')
                return out
            if args[-2:] == ['TO', 'FALSE']: raise CvtError('SET FALSE')
            # SET index TO n / UP BY
            return ['SET ' + ' '.join(self.fix_expr(args, pre))]
        if verb == 'INITIALIZE':
            out = []
            k = 0
            while k < len(args):
                j, r = self.ref(args, k); k = j
                if r['subs']: raise CvtError('INITIALIZE of a table element')
                it = self.item(r['name'], r['quals'])
                for leaf, path in leaves(it):
                    if leaf.name == 'FILLER': continue
                    if leaf.occurs > 1 or any(p.occurs > 1 for p in path):
                        # table: fill each element in a generated loop
                        out.extend(self.init_table(leaf, path)); continue
                    q = ' OF '.join([leaf.name] + [p.name for p in reversed(path)][:1]) if path else leaf.name
                    q = leaf.name + (' OF ' + it.name if leaf is not it else '')
                    out.append(f'MOVE {"ZERO" if leaf.numeric() or leaf.num_edited() or leaf.usage != "DISPLAY" else "SPACES"} TO {q}')
            return dedupe(out)
        if verb == 'MOVE':
            # MOVE src TO t1 t2 ... ; refmod on targets; FUNCTION CURRENT-DATE
            if 'TO' not in args: raise CvtError('MOVE without TO')
            ti = top_level_index(args, 'TO')
            src, tg = args[:ti], args[ti + 1:]
            if src[:2] == ['FUNCTION', 'CURRENT-DATE']:
                out = []
                k = 0
                while k < len(tg):
                    j, r = self.ref(tg, k); k = j
                    out.append(f"CALL 'CDDATE' USING {self.text(r)}")
                return out
            if src[:2] == ['FUNCTION', 'UPPER-CASE'] or src[:2] == ['FUNCTION', 'LOWER-CASE']:
                sx = self.fix_expr(src, pre)
            else:
                sx = self.fix_expr(src, pre)
            out = list(pre)
            k = 0
            plain = []
            while k < len(tg):
                j, r = self.ref(tg, k); k = j
                if r['rm']:
                    base, off, ln, const = self.rm_parts(r, out)
                    n = const
                    if not n:   # the temp must hold the whole source (a group can exceed 256)
                        try: n = max(256, self.xsize(sx) or 0)
                        except Exception: n = 256
                    tmp = self.newtmp(f'X({n})')
                    out.append(f'MOVE {" ".join(sx)} TO {tmp}')
                    out.append(f"CALL 'CDMOVC' USING {tmp} {self.const_num(1)} {ln} {self.text(base)} {off} {ln}")
                else: plain.append(self.text(r))
            if plain: out.append(f'MOVE {" ".join(sx)} TO {" ".join(plain)}')
            return out
        if verb == 'INSPECT':
            return self.inspect(args)
        if verb == 'CALL':
            a = [x for x in args if x not in ('BY', 'REFERENCE', 'CONTENT')]
            return ['CALL ' + ' '.join(self.fix_expr(a, pre))]
        if verb in ('OPEN', 'CLOSE'):
            fl = [x for x in args if x not in ('INPUT', 'OUTPUT', 'I-O', 'EXTEND')]
            out = [f'{verb} ' + ' '.join(args)]
            for f in fl:
                st = getattr(self, 'files', {}).get(f, {}).get('status')
                if st: out.append(f"MOVE '00' TO {st}")
            return out
        if verb in ('COMPUTE', 'ADD', 'SUBTRACT', 'MULTIPLY', 'DIVIDE', 'DISPLAY', 'GO', 'EXIT', 'GOBACK', 'STOP', 'OPEN', 'CLOSE', 'ACCEPT', 'SEARCH'):
            x = self.fix_expr(args, pre)
            return pre + [(verb + ' ' + ' '.join(x)).rstrip()]
        raise CvtError(f'statement {verb} not supported')

    def init_table(self, leaf, path):
        raise CvtError('INITIALIZE of a group with OCCURS: ' + leaf.name)

    def inspect(self, args):
        j, r = self.ref(args, 0)
        tgt = self.text(r)
        rest = args[j:]
        if r['rm']:
            # INSPECT x(a:b) CONVERTING: through a temp (CDMOVC out, TRANSFORM, CDMOVC back)
            if rest[0] != 'CONVERTING': raise CvtError('INSPECT of a reference modification')
            out = []
            tmp = self.refmod_get(r, out)
            out.append(f'TRANSFORM {tmp} FROM {rest[1]} TO {rest[3]}')
            self.refmod_put(r, tmp, self.const_num(self.tmpsize[tmp]), out)
            return out
        out = []
        if rest[0] == 'REPLACING':
            k = 1
            bys = set()
            while k < len(rest):
                if rest[k] in ('ALL', 'LEADING', 'FIRST') and rest[k + 2] == 'BY':
                    out.append(f'EXAMINE {tgt} REPLACING {rest[k]} {rest[k + 1]} BY {rest[k + 3]}'); bys.add(rest[k + 3]); k += 4
                elif rest[k] == 'CHARACTERS' and rest[k + 1] == 'BY' and len(bys) == 1:
                    keep, _ = self.const_lit(bys.pop()); fill, _ = self.const_lit(rest[k + 2])
                    out.append(f"CALL 'CDREPC' USING {tgt} {self.const_num(self.size_of(r['name'], r['quals']))} {keep} {fill}"); k += 3
                else: raise CvtError('INSPECT ' + ' '.join(rest))
            return out
        if rest[0] == 'CONVERTING':
            a, b = rest[1], rest[3]
            return [f'TRANSFORM {tgt} FROM {a} TO {b}']
        if rest[0] == 'TALLYING':
            cnt = rest[1]; k = 3
            out.append(f'MOVE 0 TO {cnt}')
            while k < len(rest):
                if rest[k] in ('ALL', 'LEADING'): mode = rest[k]; k += 1
                out.append(f'EXAMINE {tgt} TALLYING {mode} {rest[k]}'); out.append(f'ADD TALLY TO {cnt}'); k += 1
            return out
        raise CvtError('INSPECT ' + ' '.join(rest))


RESERVED = set('''ZERO ZEROS ZEROES SPACE SPACES LOW-VALUE LOW-VALUES HIGH-VALUE HIGH-VALUES QUOTE QUOTES NOT AND OR TO FROM
BY GIVING INTO UNTIL VARYING TIMES THRU THROUGH OF IN IS NUMERIC ALPHABETIC TRUE FALSE OTHER EQUAL GREATER LESS THAN ALL
USING RETURNING DELIMITED SIZE WITH POINTER ROUNDED REMAINDER AFTER BEFORE UPON TALLY'''.split())


def top_level_index(toks, w):
    d = 0
    for i, t in enumerate(toks):
        if t == '(': d += 1
        elif t == ')': d -= 1
        elif t == w and d == 0: return i
    raise CvtError(f'{w} not found')


def leaves(it, path=None):
    path = path or []
    if it.children:
        for c in it.children:
            if c.level == 88 or c.redefines: continue
            yield from leaves(c, path + [it])
    else:
        yield it, path


def dedupe(x):
    seen, out = set(), []
    for s in x:
        if s not in seen: seen.add(s); out.append(s)
    return out


def wrap_value(head, lit):
    """VALUE literal that may not fit in one line: continuation lines"""
    full = head + ' ' + lit + '.'
    if len(full) <= 72: return [full]
    return [head] + cont_lit('           ', lit + '.')


def cont_lit(indent, s):
    """emit text s (starting with a literal) over continuation lines (col 7 '-')"""
    lines = []
    first = indent + s
    if len(first) <= 72: return [first]
    lines.append(first[:72])
    rest = first[72:]
    while rest:
        chunk = "      -    '" + rest
        lines.append(chunk[:72]); rest = chunk[72:]
    return lines


# ---------------------------------------------------------------- emit
def compact(txt):
    """'( a ( b ) )' -> '(a(b))' outside literals: the KICKS preprocessor wants EXEC arguments and
    DFHRESP(x) / DFHVALUE(x) as one word"""
    parts = re.split(r"('(?:[^']|'')*')", txt)
    for i in range(0, len(parts), 2):
        parts[i] = re.sub(r'\(\s+', '(', re.sub(r'\s+\)', ')', parts[i]))
        parts[i] = re.sub(r'(\w)\s+\(', r'\1(', parts[i])
    return ''.join(parts)


def wrap(sent, indent=11):
    """one sentence -> lines (cols 8..72); literals never split unless longer than a line"""
    sent = re.sub(r'\b(DFHRESP|DFHVALUE)\s*\(\s*([A-Z0-9-]+)\s*\)', r'\1(\2)', sent)
    toks = re.findall(r"'(?:[^']|'')*'|\S+", sent)
    lines, cur = [], ' ' * indent
    for t in toks:
        add = (' ' if cur.strip() else '') + t
        if len(cur) + len(add) <= 72:
            cur += add
        else:
            if cur.strip(): lines.append(cur)
            cur = ' ' * (indent + 4) + t
            if len(cur) > 72:
                if t.startswith("'"):
                    ls = cont_lit(' ' * (indent + 4), t)
                    lines.extend(ls[:-1]); cur = ls[-1]
                else: raise CvtError('token too long: ' + t)
    lines.append(cur)
    return lines


def convert(path, cpydirs, keep=(), fixes=None):
    lines = expand_copies(read_lines(path), cpydirs, set(keep))
    if fixes:
        text = '\n'.join(lines)
        for fx in fixes:
            old, new, want = (fx + (1,))[:3]
            rx = r'\s+'.join(re.escape(w) for w in old.split())
            n = len(re.findall(rx, text))
            if n != want: raise CvtError(f'fix matches {n} times, not {want}: {old[:60]!r}')
            text = re.sub(rx, lambda m: new, text)
        lines = text.split('\n')
    # split divisions
    pd = next(i for i, l in enumerate(lines) if re.match(r'\s*PROCEDURE\s+DIVISION', l))
    dd = next(i for i, l in enumerate(lines) if re.match(r'\s*DATA\s+DIVISION', l))
    head, data, proc = lines[:dd], lines[dd:pd], lines[pd:]
    # a 77 item after an 01 item: the compiler wants the 77 items first; an 01 is the same here
    seen01 = False
    for i, l in enumerate(data):
        if re.match(r'\s*(WORKING-STORAGE|LINKAGE|FILE)\s+SECTION', l): seen01 = False
        elif re.match(r'\s*0?1\s', l): seen01 = True
        elif seen01 and re.match(r'\s*77\s', l): data[i] = re.sub(r'77', '01', l, count=1)
    head, files = fix_files(head)
    dtoks = tokenize(data)
    items = parse_data(dtoks)
    model = Model(items)
    pname = re.search(r'PROGRAM-ID\.\s*([A-Z0-9]+)', ' '.join(head)).group(1)
    g = Gen(model, pname)
    g.files = files
    for f in files.values():
        if f.get('nominal'): g.ws.append(f"       01  {f['nominal']} PIC X({g.size_of(f['rkey'])}).")
    # procedure division header (may span lines up to the period)
    ptoks = tokenize(proc)
    k = 0
    while ptoks[k] != '.': k += 1
    pdhead = ' '.join(ptoks[:k]) + '.'
    body = ptoks[k + 1:]
    def is_para(i):
        return (body[i + 1] in ('.', 'SECTION') and (i == 0 or body[i - 1] == '.' or body[i].a)
                and body[i] not in VERBS and body[i] not in ('END-IF', 'END-EXEC', 'END-PERFORM', 'END-EVALUATE')
                and re.fullmatch(r'[A-Z0-9][A-Z0-9-]*', body[i]) and not re.fullmatch(r'\d+', body[i]))
    paras = set(body[i] for i in range(len(body) - 1) if is_para(i))
    for i in range(len(body) - 1):
        if is_para(i): body[i].a = True
    # paragraphs
    out_paras, i = [], 0
    p = Parser(body, paras)
    cur = None
    while p.peek() is not None:
        t = p.peek()
        if t.a and (p.peek(1) == '.' or p.peek(1) == 'SECTION'):
            p.take()
            if p.peek() == 'SECTION': p.take(); t = T(t + ' SECTION')
            p.take()
            cur = (t, []); out_paras.append(cur); continue
        if t == '.': p.take(); continue
        if cur is None: cur = ('CDG-MAIN', []); out_paras.append(cur)
        st = p.stmts(set())
        if not st:
            raise CvtError(f'parse stuck at {t!r} (line {t.line}): ' + ' '.join(body[p.i:p.i + 12]))
        cur[1].extend(st)
    gen_paras = []
    for name, stmts in out_paras:
        sents = g.gen(stmts)
        if len(sents) > 1: sents = [s for s in sents if s != 'EXIT']
        gen_paras.append((name, sents))
    # duplicate paragraph names: an earlier EXIT-only one falls through into the later one; drop it
    names = [n for n, _ in gen_paras]
    gen_paras = [(n, ss) for k, (n, ss) in enumerate(gen_paras) if not (ss in ([], ['EXIT']) and n in names[k + 1:])]
    # map attribute bytes: CICS has xxxA in the input map (redefining xxxF) and the extended attributes
    # xxxC/P/H/V in both; the KICKS map generator has xxxA only in the output map, xxxC/P/H/V only in the input
    # map (same offsets): 'xxxA OF mapI' -> 'xxxA OF mapO', 'xxxC OF mapO' -> 'xxxC OF mapI'
    rec, fields = None, {}
    for l in data:
        if not l.startswith('\x00'): continue
        m = re.match(r'\s*(\d+)\s+([A-Z0-9-]+)', l[1:])
        if not m: continue
        if m.group(1) == '01': rec = m.group(2); fields[rec] = set()
        elif rec: fields[rec].add(m.group(2))
    maps = {r[:-1] for r in fields if r.endswith('I') and r[:-1] + 'O' in fields}
    def mapref(m):
        f, r = m.group(1), m.group(2)
        if r[:-1] not in maps or f[:-1] + 'I' not in fields[r[:-1] + 'I']: return m.group(0)
        if f[-1] == 'A' and r[-1] == 'I': return f'{f} OF {r[:-1]}O'
        if f[-1] in 'CPHV' and r[-1] == 'O': return f'{f} OF {r[:-1]}I'
        return m.group(0)
    consts = {'DFHBMFSE': ('CDBMFSE', "X'C1'"), 'DFHBMBRY': ('CDBMBRY', "X'C8'"), 'DFHDFCOL': ('CDDFCOL', "X'00'")}
    used = set()
    def post(sent):
        parts = re.split(r"('(?:[^']|'')*')", sent)
        for i in range(0, len(parts), 2):
            parts[i] = re.sub(r'\b([A-Z0-9-]+) OF ([A-Z0-9-]+)\b', mapref, parts[i])
            # '+ 1' after a keyword: a signed literal
            parts[i] = re.sub(r'(^|\b(?:ADD|TO|BY|FROM|GIVING|MOVE|UNTIL)|[=<>(]) ([+-]) (\d)', r'\1 \2\3', parts[i])
            for k, (n, v) in consts.items():
                if re.search(r'\b%s\b' % k, parts[i]): parts[i] = re.sub(r'\b%s\b' % k, n, parts[i]); used.add(k)
        return ''.join(parts)
    gen_paras = [(n, [post(x) for x in ss]) for n, ss in gen_paras]
    g.paras = [(n, [post(x) for x in ss]) for n, ss in g.paras]
    for k in sorted(used): g.ws.append(f'       01  {consts[k][0]} PIC X VALUE {consts[k][1]}.')
    # output
    out = []
    for l in head:
        if re.match(r'\s*(AUTHOR|DATE-WRITTEN|DATE-COMPILED|INSTALLATION|SECURITY)\.', l): continue
        out.append('       ' + l)
    out.extend(fix_data(data, g))
    out.append('       ' + pdhead)
    for name, sents in gen_paras + [('CDG-END', ['GOBACK'])] + g.paras:
        out.append('       ' + name + ('' if name.endswith('SECTION') else '') + '.')
        if not sents: sents = ['EXIT']
        for s in sents:
            out.extend(wrap(s + '.'))
    for l in out:
        if len(l) > 72: raise CvtError('line too long: ' + l)
    return out, g


def fix_files(head):
    """FILE-CONTROL: indexed files -> ISAM interface (DA-I-), FILE STATUS dropped (emulated: Gen.io)"""
    text = '\n'.join(head)
    files = {}
    def sel(m):
        t = ' '.join(m.group(0).split())
        f = re.match(r'SELECT\s+(\S+)\s+ASSIGN\s+TO\s+(\S+)', t)
        name, dd = f.group(1), f.group(2)
        st = re.search(r'FILE\s+STATUS\s+(?:IS\s+)?(\S+?)\.?(?:\s|$)', t)
        org = re.search(r'ORGANIZATION\s+(?:IS\s+)?(\S+)', t)
        acc = re.search(r'ACCESS\s+(?:MODE\s+)?(?:IS\s+)?(\S+?)\.?(?:\s|$)', t)
        key = re.search(r'RECORD\s+KEY\s+(?:IS\s+)?(\S+?)\.?(?:\s|$)', t)
        info = dict(status=st.group(1) if st else None, org=org.group(1) if org else 'SEQUENTIAL')
        files[name] = info
        if info['org'] == 'INDEXED':
            mode = acc.group(1) if acc else 'SEQUENTIAL'
            if mode == 'RANDOM':
                # ISAM random access: the key to read goes in a NOMINAL KEY in WORKING-STORAGE (set before each READ)
                info.update(nominal=f'CDK-{len(files):02d}', rkey=key.group(1))
                return (f'SELECT {name} ASSIGN TO DA-I-{dd}\n               ACCESS IS RANDOM\n'
                        f'               NOMINAL KEY IS {info["nominal"]}\n               RECORD KEY IS {key.group(1)}.')
            if mode != 'SEQUENTIAL': raise CvtError(f'{name}: ACCESS {mode}')
            return f'SELECT {name} ASSIGN TO DA-I-{dd}\n               ACCESS IS SEQUENTIAL\n               RECORD KEY IS {key.group(1)}.'
        return f'SELECT {name} ASSIGN TO UT-S-{dd}.'
    text = re.sub(r'SELECT\s[^.]*\.', sel, text)
    return text.split('\n'), files


def fix_data(data, g):
    out = []
    ws_end = None
    for l in data:
        if l.startswith('\x00'): continue
        x = l
        x = re.sub(r'(?<![-\w])BINARY(?![-\w])', 'COMP', x)
        x = re.sub(r'(?<![-\w])PACKED-DECIMAL(?![-\w])', 'COMP-3', x)
        fd = re.match(r'(\s*FD\s+)(\S+)\.\s*$', x)
        if fd:
            f = g.files.get(fd.group(2), {})
            out.append('       ' + fd.group(1) + fd.group(2))
            x = '    LABEL RECORDS ARE STANDARD' + (' BLOCK CONTAINS 10 RECORDS' if f.get('org') == 'INDEXED' else '') + '.'
        # unnamed items: "05 PIC X." -> FILLER
        x = re.sub(r'^(\s*\d\d?\s+)(PIC|PICTURE)\b', r'\1FILLER \2', x)
        out.append('       ' + x)
    # extra WORKING-STORAGE: before LINKAGE SECTION or at the end
    idx = next((i for i, l in enumerate(out) if re.match(r'\s*LINKAGE\s+SECTION', l)), len(out))
    return out[:idx] + g.ws + out[idx:]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('src'); ap.add_argument('--cpy', default=''); ap.add_argument('--keep', default='')
    ap.add_argument('-o', required=True); ap.add_argument('--maps', default='')
    a = ap.parse_args()
    MAPDIRS.extend(d for d in a.maps.split(',') if d)
    try:
        out, g = convert(a.src, [d for d in a.cpy.split(',') if d], [k for k in a.keep.split(',') if k])
    except CvtError as e:
        print(f'{a.src}: {e}', file=sys.stderr); sys.exit(2)
    open(a.o, 'w').write('\n'.join(out) + '\n')
    print(f'{os.path.basename(a.src)}: {len(out)} lines, {len(g.paras)} generated paragraphs')


if __name__ == '__main__':
    main()
