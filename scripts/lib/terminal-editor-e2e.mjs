export async function verifyEditorUnicodeResizeAndLargeFile(driver, tag) {
  const unicodePath = `${tag}-unicode.txt`;
  const largePath = `${tag}-large.txt`;
  const unicode = await verifyUnicodeVi(driver, unicodePath);
  const fixtureCreated = await writeLargeEditorFixture(driver, largePath, tag);
  const large = await verifyLargeNano(driver, largePath);
  return {
    unicode: unicode.opened && unicode.exited && unicode.saved,
    resize: large.resized.cols === 20 && large.resized.rows === 10 && large.narrowRedraw,
    large: fixtureCreated && large.opened && large.exited && large.saved,
    fixtureCreated,
    unicodeDetail: unicode,
    largeDetail: large,
  };
}

async function verifyUnicodeVi({ focus, insert, enter, key, sleep, waitForText, exitRawProgram, command }, path) {
  await focus();
  await insert(`vi ${path}`);
  await enter();
  await sleep(150);
  const opened = await waitForText(`vi: /workspace/${path}`);
  await insert('i界😀');
  await sleep(100);
  await key('Escape', 'Escape', 0, 27);
  await sleep(100);
  await insert(':wq');
  await sleep(100);
  const exited = await exitRawProgram(() => enter());
  const saved = exited && await command(`cat ${path}`, '界😀');
  return { opened, exited, saved };
}

async function writeLargeEditorFixture({ command }, path, tag) {
  const program = `node -e "for(let i=0;i<4096;i++)console.log('line-'+String(i).padStart(4,'0')+' 中文界😀')" > ${path}; echo ${tag}-large-ready`;
  return command(program, `${tag}-large-ready`, 60_000);
}

async function verifyLargeNano(driver, path) {
  const { focus, insert, enter, key, sleep, waitForText, exitRawProgram, command, evalValue } = driver;
  await focus();
  await insert(`nano ${path}`);
  await enter();
  await sleep(150);
  const opened = await waitForText(`nano: /workspace/${path}`);
  const resized = await evalValue(`(() => {
    const term = window.__succinixBench.term;
    term.resize(20, 10);
    return { cols: term.cols, rows: term.rows };
  })()`);
  const narrowRedraw = await waitForText('line-0000 中...', 5_000);
  await focus();
  await insert('X');
  await sleep(150);
  await key('o', 'KeyO', 2, 79);
  await sleep(150);
  await evalValue(`(() => {
    const term = window.__succinixBench.term;
    term.resize(80, 24);
    return { cols: term.cols, rows: term.rows };
  })()`);
  await sleep(150);
  await focus();
  const exited = await exitRawProgram(() => key('x', 'KeyX', 2, 88));
  const saved = exited && await command(`head -n 1 ${path}; tail -n 1 ${path}`, 'Xline-0000 中文界😀', 60_000)
    && await waitForText('line-4095 中文界😀', 10_000);
  return { opened, resized, narrowRedraw, exited, saved };
}
