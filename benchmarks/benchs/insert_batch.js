const assert = require('assert');

const basechars = '123456789abcdefghijklmnop\\Z';
const chars = basechars.split('');
chars.push('😎');
chars.push('🌶');
chars.push('🎤');
chars.push('🥂');

function randomString(length) {
  let result = '';
  for (let i = length; i > 0; --i) result += chars[Math.round(Math.random() * (chars.length - 1))];
  return result;
}

let sqlTable = 'CREATE TABLE perfTestTextBatch (id MEDIUMINT NOT NULL AUTO_INCREMENT,t0 text' + ', PRIMARY KEY (id))';
sqlInsert = 'INSERT INTO perfTestTextBatch(t0) VALUES (?)';

module.exports.title =
  "100 * insert 100 characters using batch method (for mariadb) or loop for other driver (batch doesn't exists)";
module.exports.displaySql = 'INSERT INTO perfTestTextBatch VALUES (?)';
const iterations = 100;
module.exports.benchFct = function (conn, deferred, connType) {
  const params = [randomString(100)];
  // console.log(connType.desc);
  if (!connType.desc.includes('mariadb')) {
    //other driver doesn't have bulk method
    let ended = 0;
    for (let i = 0; i < iterations; i++) {
      conn
        .query(sqlInsert, params)
        .then((rows) => {
          // let val = Array.isArray(rows) ? rows[0] : rows;
          // assert.equal(1, val.info ? val.info.affectedRows : val.affectedRows);
          if (++ended === iterations) {
            deferred();
          }
        })
        .catch((err) => {
          throw err;
        });
    }
  } else {
    //use batch capability
    const totalParams = new Array(iterations);
    for (let i = 0; i < iterations; i++) {
      totalParams[i] = params;
    }
    conn
      .batch(sqlInsert, totalParams)
      .then((rows) => {
        deferred();
      })
      .catch((err) => {
        throw err;
      });
  }
};

module.exports.initFct = async function (conn) {
  try {
    await Promise.all([
      conn.query('DROP TABLE IF EXISTS perfTestTextBatch'),
      conn.query("INSTALL SONAME 'ha_blackhole'"),
      conn.query(sqlTable + " ENGINE = BLACKHOLE COLLATE='utf8mb4_unicode_ci'")
    ]);
  } catch (err) {
    await Promise.all([
      conn.query('DROP TABLE IF EXISTS perfTestTextBatch'),
      conn.query(sqlTable + " COLLATE='utf8mb4_unicode_ci'")
    ]);
  }
};

module.exports.onComplete = async function (conn) {
  await conn.query('TRUNCATE TABLE perfTestTextBatch');
};
