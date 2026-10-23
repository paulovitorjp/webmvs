#!/usr/bin/perl
# SPDX-License-Identifier: Apache-2.0
# Usage: cmd | tslog.pl <plain-log> > <timestamped-log>
# Copies stdin to <plain-log> unchanged and to stdout with "<epoch.ms> " in front of each line.
use strict; use Time::HiRes qw(time);
open(my $L, '>', $ARGV[0]) or die "open $ARGV[0]: $!";
select((select($L), $| = 1)[0]); $| = 1;
while (my $l = <STDIN>) { print $L $l; printf "%.3f %s", time, $l; }
