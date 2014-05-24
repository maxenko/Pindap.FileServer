#!/usr/bin/env node
/*
 * Pindap File Server
 * https://github.com/maxenko/pindap.file.server
 *
 * Copyright 2012, Maxim Ostapenko
 * http://enkolab.com
 *
 * based on https://github.com/blueimp/jQuery-File-Upload
 *
 * Licensed under the MIT license:
 * http://www.opensource.org/licenses/MIT
 */

(function (port) {
    'use strict';
    var path = require('path'),
        fs = require('fs'),
        _existsSync = fs.existsSync || path.existsSync,
        formidable = require('formidable'),
        nodeStatic = require('node-static'),
        imageMagick = require('imagemagick'),
        url = require('url'),
        cb = require('couchbase'),
        async = require('async'),
        _ = require('underscore'),
        tools = require('./tools.js'),
        models = require('./models.js'),
        curTransfers = {},

        options = {
            tmpDir: __dirname + '/temp',
            publicDir: __dirname + '/public',
            uploadDir: __dirname + '/public/files',
            uploadUrl: '/files/',
            maxPostSize: 5000000, // 4mb
            minFileSize: 1,
            maxFileSize: 4900000, // 4mb
            acceptFileTypes: /.+/i,
            // Files not matched by this regular expression force a download dialog,
            // to prevent executing any scripts in the context of the service domain:
            inlineFileTypes: /\.(gif|jpe?g|png)$/i,
            imageTypes: /\.(gif|jpe?g|png)$/i,
            imageVersions: {
                'thumbnail': {
                    width: 115,
                    height: 115
                }
            },
            accessControl: {
                allowOrigin: '*',
                allowMethods: 'OPTIONS, HEAD, GET, POST, PUT, DELETE',
                allowHeaders: 'Content-Type, Content-Range, Content-Disposition'
            },
            /* Uncomment and edit this section to provide the service via HTTPS:
             ssl: {
             key: fs.readFileSync('/Applications/XAMPP/etc/ssl.key/server.key'),
             cert: fs.readFileSync('/Applications/XAMPP/etc/ssl.crt/server.crt')
             },
             */
            nodeStatic: {
                cache: 3600 // seconds to cache served files
            }
        },

    utf8encode = function (str) {
            return unescape(encodeURIComponent(str));
    },

    getCfg = function(){
        var cfg;
        var configFilename = 'config.json';
        if (fs.existsSync(configFilename)) {
            cfg = JSON.parse(fs.readFileSync(configFilename));
        } else {
            tools.logd(configFilename + " not found. Using default");
            cfg = { };
        }

        return cfg;
    },

    bucket = null,

    fileServer = new nodeStatic.Server(options.publicDir, options.nodeStatic),
        nameCountRegexp = /(?:(?: \(([\d]+)\))?(\.[^.]+))?$/,
        nameCountFunc = function (s, index, ext) {
            return ' (' + ((parseInt(index, 10) || 0) + 1) + ')' + (ext || '');
        },
        FileInfo = function (file) {
            this.name = file.name;
            this.size = file.size;
            this.type = file.type;
            this.deleteType = 'DELETE';
        },
        UploadHandler = function (req, res, callback) {
            this.req = req;
            this.res = res;
            this.callback = callback;
        },
        serve = function (req, res) {

            var query = url.parse(req.url, true).query;

            res.setHeader(
                'Access-Control-Allow-Origin',
                options.accessControl.allowOrigin
            );
            res.setHeader(
                'Access-Control-Allow-Methods',
                options.accessControl.allowMethods
            );
            res.setHeader(
                'Access-Control-Allow-Headers',
                options.accessControl.allowHeaders
            );
            var handleResult = function (result, redirect) {
                    if (redirect) {
                        res.writeHead(302, {
                            'Location': redirect.replace(
                                /%s/,
                                encodeURIComponent(JSON.stringify(result))
                            )
                        });
                        res.end();
                    } else {
                        if(req.headers.accept){
                            res.writeHead(200, {
                                'Content-Type': req.headers.accept.indexOf('application/json') !== -1 ?
                                    'application/json' : 'text/plain'
                            });
                        }
                        res.end(JSON.stringify(result));
                    }
                },
                setNoCacheHeaders = function () {
                    res.setHeader('Pragma', 'no-cache');
                    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
                    res.setHeader('Content-Disposition', 'inline; filename="files.json"');
                },
                handler = new UploadHandler(req, res, handleResult);
            switch (req.method) {
                case 'OPTIONS':
                    res.end();
                    break;
                case 'HEAD':
                case 'GET':
                    // list only for global dir of files (top 100) or for specific uid
                    if (req.url === '/' || req.url.indexOf('/?uid=') == 0) {
                        tools.logd("Pulling image index for: " + (!query.uid ? 'global' : query.uid));
                        setNoCacheHeaders();
                        if (req.method === 'GET') {
                            handler.get(query.uid);
                        } else {
                            res.end();
                        }
                    } else {
                        fileServer.serve(req, res);
                    }
                    break;
                case 'POST':
                    setNoCacheHeaders();
                    var uid = handler.req.url.replace("/?uid=","");
                    handler.post((!uid ? 'global' : uid));
                    break;
                case 'DELETE':
                    handler.destroy();
                    break;
                default:
                    res.statusCode = 405;
                    res.end();
            }
        };
    fileServer.respond = function (pathname, status, _headers, files, stat, req, res, finish) {
        // Prevent browsers from MIME-sniffing the content-type:
        _headers['X-Content-Type-Options'] = 'nosniff';
        if (!options.inlineFileTypes.test(files[0])) {
            // Force a download dialog for unsafe file extensions:
            _headers['Content-Type'] = 'application/octet-stream';
            _headers['Content-Disposition'] = 'attachment; filename="' +
                utf8encode(path.basename(files[0])) + '"';
        }
        nodeStatic.Server.prototype.respond.call(this, pathname, status, _headers, files, stat, req, res, finish);
    };

    FileInfo.prototype.validate = function () {
        if (options.minFileSize && options.minFileSize > this.size) {
            this.error = 'File is too small';
        } else if (options.maxFileSize && options.maxFileSize < this.size) {
            this.error = 'File is too big';
        } else if (!options.acceptFileTypes.test(this.name)) {
            this.error = 'Filetype not allowed';
        }
        return !this.error;
    };

    var validateAsync = function(uid,cb){

        // check if user uploaded too many files in last x hours...
        var count = 0;
        var hourLimit = 4;
        var limit = 100;

        // get uid/file stubs from db
        var params =  {
            "stale"         : "false",
            "startkey"      : [uid,9007199254740992],
            "endkey"        : [uid,0],
            "descending"    : true,
            "connection_timeout" : 60000,
            "limit" : limit
        };
        var error;
        var q = bucket.view("stats", "uploads_in_interval", params);
        q.query(function(err,view){

            if(err){
                tools.logd("Error checking upload limit interval for uid: "+uid)
                return;
            }
            var fourHrsAgo = Date.now()-1000*60*60*hourLimit; // 1000*60*60*hours
            _.map(view,function(assoc){
                if(assoc.key[1] > fourHrsAgo){
                    ++count;
                }
            });

            if(count >= limit){
                error = "Upload limit of "+limit+" files per "+hourLimit+"h reached."
                tools.logd("User reached their upload limit with: "+count+" in last "+hourLimit+" hours.");
            }

            // pass error to cb chain (form.on('file') should take care of cancelling the request)
            cb(!error);
        });

    };

    FileInfo.prototype.safeName = function () {
        // Prevent directory traversal and creating hidden system files:
        this.name = path.basename(this.name).replace(/^\.+/, '');
        // Prevent overwriting existing files:
        while (_existsSync(options.uploadDir + '/' + this.name)) {
            this.name = this.name.replace(nameCountRegexp, nameCountFunc);
        }
    };
    FileInfo.prototype.initUrls = function (req) {
        if (!this.error) {
            var that = this,
                baseUrl = (options.ssl ? 'https:' : 'http:') +
                    '//' + req.headers.host + options.uploadUrl;
            this.url = this.deleteUrl = baseUrl + encodeURIComponent(this.name);
            Object.keys(options.imageVersions).forEach(function (version) {
                if (_existsSync(
                    options.uploadDir + '/' + version + '/' + that.name
                )) {
                    that[version + 'Url'] = baseUrl + version + '/' +
                        encodeURIComponent(that.name);
                }
            });
        }
    };
    UploadHandler.prototype.get = function (uid) {

        var handler = this;

        // get uid/file stubs from db
        var params =  {
            "full_set" : "true",
            "stale" : "false",
            "limit": "30",
            "descending": "true",
            "startkey": [uid,9007199254740992], // sort desc - most recent files first
            "endkey":[uid]
        };

        var q = bucket.view("post", "files_by_uid", params);
        q.query(function(err,view){
            if(err) {
                tools.logd("View error: "+err);
                //cb([]);
                return;
            }

            // check if file exists, if it does, add it to result set, if it doesn't delete the stub.
            var files = [],
                statList = [];

            _.map(view,function(assoc){
                var fname = assoc.value,
                    path = options.uploadDir + '/' + fname,
                    exists = fs.existsSync(path);

                if(exists){
                    var stats = fs.statSync(path);
                    if(stats.isFile() && fname[0] != '.'){
                        stats.name = fname;
                        statList.push(stats);
                    }
                }else{
                    // delete stub, and thumbnail
                    var thumbPath = options.uploadDir + '/thumbnail/' + fname;
                    async.parallel([

                        function(){bucket.remove(assoc.id,function(err,meta){})},
                        function(){
                            // delete thumbnail file, if one exists
                            fs.exists( thumbPath, function(exists){
                                if(exists){
                                    try{
                                        fs.unlink(thumbPath);
                                        tools.logd("Removed orphaned: "+thumbPath);
                                    }catch(e){
                                        tools.logd("Error removing orphaned: "+thumbPath+" "+e);
                                    }
                                };
                            });
                        }

                    ]);
                }
            });

            // sort by date (most recent on top)
            statList.sort(function(a,b){
                if (a.mtime.getTime() < b.mtime.getTime()) return 1;
                if (a.mtime.getTime() > b.mtime.getTime()) return -1;
                return 0;
            });

            var top = 0,limit = parseInt(params.limit);
            statList.forEach(function(s){
                var fileInfo = new FileInfo({
                    name: s.name,
                    size: s.size
                });
                fileInfo.initUrls(handler.req);
                if(top < limit) files.push(fileInfo);
                ++top;
            });

            handler.callback({files: files});

        },null);
    };
    UploadHandler.prototype.post = function (uid) {
        var handler = this,
            form = new formidable.IncomingForm(),
            tmpFiles = [],
            files = [],
            map = {},
            counter = 1,
            redirect,
            finish = function () {
                counter -= 1;
                if (!counter) {
                    files.forEach(function (fileInfo) {
                        fileInfo.initUrls(handler.req);
                    });
                    handler.callback({files: files}, redirect);
                }
            };

        form.uid = uid; // custom prop to hold uid

        form.uploadDir = options.tmpDir;

        form.on('fileBegin', function (name, file) {

            console.log('fileBegin');

            tools.logd("Beginning upload of: "+file.name+" for uid: "+form.uid);

            validateAsync(uid,function(isAllowedToProceed){


                if(!isAllowedToProceed){
                    form.emit('error',"limit reached");
                    handler.req.connection.destroy();
                    return;
                }

                tmpFiles.push(file.path);
                var fileInfo = new FileInfo(file, handler.req, true);
                fileInfo.safeName();
                map[path.basename(file.path)] = fileInfo;
                files.push(fileInfo);

                console.log('validateAsync cb');

            }); // validateAsync
        });
        form.on('field', function (name, value) {
                if (name === 'redirect') {
                    redirect = value;
                }
            });



        form.on('file', function (name, file) {
            console.log('file');
            var fileInfo = map[path.basename(file.path)];
            console.log("File: "+file.path);

            if(!fileInfo){
                console.log('file event found fileInfo to be NULL');
                return;
            }


            fileInfo.size = file.size;
            console.log("Size: "+file.size);
            if (!fileInfo.validate()) {
                fs.unlink(file.path);
                return;
            }
            if(fs.existsSync(file.path)){
                try{
                    fs.renameSync(file.path, options.uploadDir + '/' + fileInfo.name);
                    if (options.imageTypes.test(fileInfo.name)) {
                        Object.keys(options.imageVersions).forEach(function (version) {
                            counter += 1;
                            var opts = options.imageVersions[version];

                            // Exclude gifs (animated or not) from resizing, and create a symlink in /version to the
                            // original file instead. Takes way too much CPU and is a total waste of space and possibly
                            // bandwith since resized animated gifs are about the same size! Let the DOM and browser
                            // deal with resizing.

                            tools.logd("Resizing: "+fileInfo.name);

                            if( fileInfo.name.endsWith('gif')){
                                tools.logd(fileInfo.name+" is a GIF. Skipping resize, creating symlink in /"+version+"/ instead.");
                                fs.symlink(
                                    options.uploadDir + '/' + fileInfo.name,
                                    options.uploadDir + '/' + version + '/' + fileInfo.name,
                                    function(err){
                                        if(err) tools.logd("Error creating link to "+version+" for "+fileInfo.name+" msg: "+err);
                                    }
                                );
                            }else{
                                imageMagick.resize({
                                    width: opts.width,
                                    height: opts.height,
                                    srcPath: (options.uploadDir + '/' + fileInfo.name),
                                    dstPath: (options.uploadDir + '/' + version + '/' + fileInfo.name),
                                    resizeArgs: {}
                                }, function(e, stdout, stderr){
                                    if(e) tools.logd("Error resizing thumbnail (imageMagick): "+e);
                                });
                            }

                            // log file association to DB
                            try{
                                // log file association for the uploader
                                var keys = Object.keys(map);
                                var fileAssoc = new models.FileAssociation({uid:form.uid,file:map[keys[0]].name});

                                bucket.set("file_"+tools.guid(),fileAssoc,function(e,fileAssoc){
                                    if(e){
                                        tools.logd("Error associating file: "+fileAssoc);
                                    }
                                });
                            }catch(e){
                                tools.logd("Couldn's store stub: "+e);

                            }

                        });
                    }
                }catch(error){
                    tools.logd("form.on('file'): "+error);
                    finish();
                }
            }

        });

        form.on('aborted', function (e) {
            tmpFiles.forEach(function (file) {
                fs.unlink(file);
            });
        });

        form.on('error', function (e) {
            tools.logd("form.on('error'): " + e);
        });

        form.on('progress', function (bytesReceived, bytesExpected) {
            //console.log("form.on('progress'");
            // report upload size to console on reception
            async.parallel([
                function(){
                    var keys = Object.keys(map);
                    if(keys && keys.length && bytesReceived == bytesExpected){
                        tools.logd("Received: "+map[keys[0]].name+" totaling: "+bytesExpected+" bytes for uid: "+form.uid);
                    }
                }]);

            if (bytesReceived > options.maxPostSize) {
                handler.req.connection.destroy();
            }
        });

        form.on('end', function(){
            finish();
        }).parse(handler.req);
    };

    UploadHandler.prototype.destroy = function () {
        var handler = this,
            fileName;
        if (handler.req.url.slice(0, options.uploadUrl.length) === options.uploadUrl) {
            fileName = path.basename(decodeURIComponent(handler.req.url));
            if (fileName[0] !== '.') {
                fs.unlink(options.uploadDir + '/' + fileName, function (ex) {
                    Object.keys(options.imageVersions).forEach(function (version) {
                        fs.unlink(options.uploadDir + '/' + version + '/' + fileName);
                    });
                    handler.callback({success: !ex});
                });
                return;
            }
        }
        handler.callback({success: false});
    };

    tools.logd("starting server...");

    bucket = new cb.Connection(getCfg(), function(err) {
        if (err) {
            throw "Cannot connect to couchbase. Reason: "+err;
        }
    });

    if (options.ssl) {
        tools.logd("started with ssl on port: "+port)
        require('https').createServer(options.ssl, serve).listen(port);
    } else {
        tools.logd("started on port: "+port)
        require('http').createServer(serve).listen(port);
    }

}(8888));